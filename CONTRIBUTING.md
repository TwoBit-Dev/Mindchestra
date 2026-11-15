# Contributing

Mindchestra is currently under active development by TwoBit Dev.

## Development Workflow

1. Fork or branch from `main` using a scoped branch name.
2. Keep changes focused on a single module or concern.
3. Ensure `pnpm typecheck`, `pnpm build`, and `pnpm test` pass before opening a pull request.
4. Never commit credentials, local database artifacts, or proprietary provider tokens.

## Code Standards

- Strict TypeScript across all workspace packages.
- Runtime schema validation at package and API boundaries.
- Deterministic tests without external network or live credential dependencies in CI.
