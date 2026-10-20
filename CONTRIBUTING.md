# Contributing

Thanks for improving Codex Skills MCP.

## Development setup

```bash
git clone https://github.com/Zhan-ZhangZ/codex-skills-mcp.git
cd codex-skills-mcp
npm ci
npm test
```

The test suite is designed to run offline. Use `npm run preview:app` for the
MCP App preview workflow.

## Before opening a pull request

- Keep changes scoped and explain the user-visible outcome.
- Add or update tests for behavior changes.
- Update the relevant file in `docs/` and `CHANGELOG.md` when appropriate.
- Run:

```bash
npm test
npm run build:plugin
npm run check:package
```

- Do not commit local caches, virtual environments, nested repositories,
  marketing renders or `.DS_Store` files.

## Pull request description

Include:

1. the problem and affected clients;
2. the chosen approach and notable tradeoffs;
3. verification commands and results;
4. security, compatibility or licensing implications.

## Code style

- TypeScript ESM, strict typing.
- Prefer small modules and explicit error handling.
- Do not log credentials, tokens or complete customer content.
- Preserve UTF-8 behavior and Windows-compatible path handling.

## Licensing of contributions

By submitting a contribution, you confirm that you have the right to contribute
it and agree that it is licensed under the repository's current license.

## Security

Do not report vulnerabilities in a public issue. Follow
[SECURITY.md](SECURITY.md).
