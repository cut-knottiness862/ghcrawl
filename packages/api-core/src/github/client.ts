export type GitHubClient = {
  checkAuth: (reporter?: GitHubReporter) => Promise<void>;
  getRepo: (owner: string, repo: string, reporter?: GitHubReporter) => Promise<Record<string, unknown>>;
  listRepositoryIssues: (
    owner: string,
    repo: string,
    since?: string,
    limit?: number,
    reporter?: GitHubReporter,
  ) => Promise<Array<Record<string, unknown>>>;
  getPull: (owner: string, repo: string, number: number, reporter?: GitHubReporter) => Promise<Record<string, unknown>>;
  listIssueComments: (owner: string, repo: string, number: number, reporter?: GitHubReporter) => Promise<Array<Record<string, unknown>>>;
  listPullReviews: (owner: string, repo: string, number: number, reporter?: GitHubReporter) => Promise<Array<Record<string, unknown>>>;
  listPullReviewComments: (
    owner: string,
    repo: string,
    number: number,
    reporter?: GitHubReporter,
  ) => Promise<Array<Record<string, unknown>>>;
};

export type GitHubReporter = (message: string) => void;

type RequestOptions = {
  token: string;
  userAgent?: string;
  timeoutMs?: number;
  pageDelayMs?: number;
};

class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GitHubRequestError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatResetTime(resetSeconds: string | null): string | null {
  if (!resetSeconds) return null;
  const value = Number(resetSeconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function isRateLimitedResponse(res: Response, bodyText: string): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  if (res.headers.get('x-ratelimit-remaining') === '0') return true;
  return /rate limit/i.test(bodyText);
}

function parseRetryDelayMs(res: Response, attempt: number, bodyText: string): number {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
  }

  const resetAt = res.headers.get('x-ratelimit-reset');
  if (resetAt) {
    const resetSeconds = Number(resetAt);
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      const waitUntilResetMs = Math.max(resetSeconds * 1000 - Date.now(), 0);
      if (waitUntilResetMs > 0) return waitUntilResetMs;
    }
  }

  if (isRateLimitedResponse(res, bodyText)) {
    return 5000 + 1000 * 2 ** Math.max(attempt - 1, 0);
  }

  return Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 8000);
}

export function makeGitHubClient(options: RequestOptions): GitHubClient {
  const userAgent = options.userAgent ?? 'gitcrawl';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pageDelayMs = options.pageDelayMs ?? 5000;

  async function request<T>(url: string, reporter?: GitHubReporter): Promise<{ data: T; headers: Headers }> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        if (attempt === 1) {
          reporter?.(`[github] request ${url}`);
        }
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': userAgent,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          return { data: (await res.json()) as T, headers: res.headers };
        }

        const text = await res.text().catch(() => '');
        const shouldRetry = res.status >= 500 || isRateLimitedResponse(res, text);
        if (shouldRetry && attempt < 5) {
          const waitMs = parseRetryDelayMs(res, attempt, text);
          const resetAt = formatResetTime(res.headers.get('x-ratelimit-reset'));
          const rateRemaining = res.headers.get('x-ratelimit-remaining');
          const reason = isRateLimitedResponse(res, text) ? 'rate-limited' : `http ${res.status}`;
          const resetNote = resetAt ? ` reset_at=${resetAt}` : '';
          const remainingNote = rateRemaining ? ` remaining=${rateRemaining}` : '';
          reporter?.(
            `[github] backoff ${reason} attempt=${attempt} wait=${formatDuration(waitMs)}${remainingNote}${resetNote} url=${url}`,
          );
          await delay(waitMs);
          continue;
        }

        throw new GitHubRequestError(
          `GitHub API failed ${res.status} ${res.statusText} for ${url}: ${text.slice(0, 2000)}`,
          shouldRetry,
        );
      } catch (error) {
        if (error instanceof GitHubRequestError) {
          if (error.retryable && attempt < 5) {
            const waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
            reporter?.(`[github] retryable error attempt=${attempt} wait=${formatDuration(waitMs)} url=${url} error=${error.message}`);
            await delay(waitMs);
            continue;
          }
          throw error;
        }
        if (attempt < 5) {
          const waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
          const message = error instanceof Error ? error.message : String(error);
          reporter?.(`[github] network error attempt=${attempt} wait=${formatDuration(waitMs)} url=${url} error=${message}`);
          await delay(waitMs);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`GitHub request failed for ${url} after ${attempt} attempts: ${message}`);
      }
    }
  }

  async function paginate<T>(url: string, limit?: number, reporter?: GitHubReporter): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = url;
    while (next) {
      const response: { data: T[]; headers: Headers } = await request<T[]>(next, reporter);
      const data = typeof limit === 'number' ? response.data.slice(0, Math.max(limit - out.length, 0)) : response.data;
      const headers: Headers = response.headers;
      out.push(...data);
      if (typeof limit === 'number' && out.length >= limit) {
        break;
      }
      const link: string | null = headers.get('link');
      const match: RegExpMatchArray | null | undefined = link?.match(/<([^>]+)>;\s*rel="next"/);
      next = match?.[1] ?? null;
      if (next) {
        reporter?.(`[github] page boundary wait=${formatDuration(pageDelayMs)} next=${next}`);
        await delay(pageDelayMs);
      }
    }
    return out;
  }

  return {
    async checkAuth(reporter) {
      await request('https://api.github.com/rate_limit', reporter);
    },
    async getRepo(owner, repo, reporter) {
      const { data } = await request<Record<string, unknown>>(`https://api.github.com/repos/${owner}/${repo}`, reporter);
      return data;
    },
    async listRepositoryIssues(owner, repo, since, limit, reporter) {
      const search = new URLSearchParams({
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: '100',
      });
      if (since) search.set('since', since);
      return paginate<Record<string, unknown>>(
        `https://api.github.com/repos/${owner}/${repo}/issues?${search.toString()}`,
        limit,
        reporter,
      );
    },
    async getPull(owner, repo, number, reporter) {
      const { data } = await request<Record<string, unknown>>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
        reporter,
      );
      return data;
    },
    async listIssueComments(owner, repo, number, reporter) {
      return paginate<Record<string, unknown>>(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
        undefined,
        reporter,
      );
    },
    async listPullReviews(owner, repo, number, reporter) {
      return paginate<Record<string, unknown>>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
        undefined,
        reporter,
      );
    },
    async listPullReviewComments(owner, repo, number, reporter) {
      return paginate<Record<string, unknown>>(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
        undefined,
        reporter,
      );
    },
  };
}
