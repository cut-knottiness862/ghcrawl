# Cluster Storage Cleanup Plan

## Context

Today, each cluster rebuild writes a fresh `cluster_run` and then prunes older cluster runs for the same repo. This is simple and keeps reads easy, but it means every rebuild does substantial delete and insert churn in shared SQLite tables:

- `cluster_runs`
- `clusters`
- `cluster_members`
- `similarity_edges`

That is acceptable for a single large repo, but it gets less attractive as one local database accumulates multiple large repos. The churn is not physically isolated per repo; deletes and inserts touch shared table and index pages.

## Current State

- Cluster data is stored in shared global tables keyed by `repo_id` and `cluster_run_id`.
- Reads effectively use the latest completed run for a repo.
- Rebuilds currently:
  1. create a new cluster run
  2. write fresh edges/clusters/members
  3. prune older runs for that repo

## Problem

For large repos and repeated rebuilds, shared-table delete/reinsert cycles can cause:

- extra page churn
- index churn
- fragmentation
- longer rebuild times as the local DB grows across multiple repos

The transaction around cluster writes helps, but it does not change the underlying shared-table churn pattern.

## Preferred Next Design

Move to an append-only cluster run model with an explicit active-run pointer per repo.

### Proposed shape

Add a repo-scoped cluster state table, for example:

```sql
create table repo_cluster_state (
  repo_id integer primary key references repositories(id) on delete cascade,
  active_cluster_run_id integer references cluster_runs(id) on delete set null,
  previous_cluster_run_id integer references cluster_runs(id) on delete set null,
  updated_at text not null
);
```

### Write path

Cluster rebuild should:

1. create a new `cluster_run`
2. insert the new run's `similarity_edges`, `clusters`, and `cluster_members`
3. atomically flip `repo_cluster_state.active_cluster_run_id` to the new run
4. optionally keep the previous run id for rollback/debug visibility

This keeps the hot rebuild path mostly insert-only.

### Read path

TUI, CLI, and API cluster reads should use `repo_cluster_state.active_cluster_run_id` instead of "latest completed run by timestamp/id".

### Cleanup path

Old cluster runs should be pruned separately instead of during every rebuild. Options:

- keep only latest `N` runs per repo
- prune by age
- expose an explicit maintenance command such as `ghcrawl cluster-prune`

This makes cleanup a controlled maintenance operation instead of part of the primary rebuild hot path.

## Non-Goals

- Do not create per-repo physical tables. That would complicate migrations, queries, and maintenance too much for SQLite.
- Do not introduce a write queue for SQLite cluster persistence. Transactions are the right first optimization; a queue does not solve the underlying storage-layout concern.

## Why this is better

- less delete churn during normal rebuilds
- cleaner operational model for multiple large repos in one DB
- simpler rollback/debug story if we want to compare old vs new cluster runs
- preserves deterministic full-run clustering without incremental cluster mutation complexity

## When to do it

Not urgent for the current single-repo usage pattern. Revisit when:

- multiple large repos are common in one DB
- cluster rebuild time becomes dominated by persistence churn rather than similarity computation
- fragmentation/file-growth becomes noticeable in local usage
