# Security Policy

## Supported versions

Security fixes target the latest published release and the current `main`
branch. Pre-release versions may change quickly.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or Security Advisory flow
for this repository. Do not open a public issue containing exploit details.

Include:

- affected version and MCP host;
- reproduction steps;
- impact and required preconditions;
- relevant logs with secrets removed.

## Security model

Codex Skills MCP treats remote skill content as untrusted input.

### Protected boundaries

- Skill paths must remain inside the selected skill directory.
- Symlink and adjacent-prefix escapes are rejected.
- HTTP mode validates Host/Origin and binds to loopback by default.
- App-rendered Markdown is sanitized and external links use safe opener flags.
- File downloads are checked against expected size and Git blob SHA where
  available.

### Credentials

GitHub credentials are sent only to GitHub endpoints. Accelerator and fallback
mirror requests do not receive `Authorization` headers.

### Local data

The manifest, skill cache, search history, settings and activity logs stay in
the local cache/settings directories unless an administrator deploys HTTP mode
and intentionally exposes it.

## Deployment guidance

- Do not expose an unauthenticated HTTP server to the public internet.
- Use TLS, authentication and rate limiting in front of remote deployments.
- Restrict `--allowed-hosts` to the public hostnames you control.
- Review fetched skill scripts and their upstream licenses before commercial
  redistribution.
