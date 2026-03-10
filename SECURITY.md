# Security

## Supported Versions

`ghcrawl` is currently supported from the latest `main` branch and the latest published npm release.

## Reporting A Vulnerability

If you believe you have found a security issue in `ghcrawl`, please report it privately to:

- `harold@pwrdrvr.com`

Please do not open a public GitHub issue for credential exposure, command-injection, dependency compromise, or any issue that could put users or their API keys at risk before a fix is available.

## Repo Security Baseline

This repository is intended to use the following baseline:

- GitHub secret scanning and push protection enabled in repository settings
- Dependabot for npm and GitHub Actions updates
- CodeQL scanning for JavaScript/TypeScript
- A scheduled runtime dependency audit
- npm publish provenance / trusted publishing when configured on npmjs.com

## Operator-Facing Risk Areas

This project commonly handles:

- GitHub personal access tokens
- OpenAI API keys
- local SQLite datasets containing issue and pull request metadata

Operators are responsible for protecting their credentials, monitoring spend, and making sure their use of external platform APIs complies with the relevant terms and policies.
