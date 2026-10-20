# Configuration

CLI values override persisted settings, which override built-in defaults.
Persisted settings are stored at
`~/.codex-skills-mcp/settings.json`.

## CLI options

| Option | Default | Description |
|---|---|---|
| `--skills-dir <path>` | unset | Use a local skill library and disable remote mode |
| `--local` | off | Require a local skill library |
| `--cache-dir <path>` | `~/.codex-skills-cache` | Skill and manifest cache |
| `--github-repo <owner/repo>` | `Zhan-ZhangZ/codexprojec` | Source skill repository |
| `--github-branch <branch>` | `main` | Source branch |
| `--github-path <path>` | `codex-skills` | Skill-library directory in the source repo |
| `--github-token <token>` | auto-detected | GitHub credential for authoritative requests |
| `--http` | off | Start Streamable HTTP instead of stdio |
| `--host <address>` | `127.0.0.1` | HTTP bind address |
| `--port <port>` | `3456` | HTTP port; `0` selects a free port |
| `--allowed-hosts <hosts>` | local hosts | Comma-separated Host/Origin allowlist |
| `--tool-profile <mode>` | `auto` | `auto`, `core` or `full` |
| `--download-concurrency <n>` | `16` | Parallel file downloads, 1–64 |
| `--download-timeout <seconds>` | `30` | Per-request network deadline, 1–300 |
| `--soft-deadline-seconds <n>` | `55` | Partial-response deadline without progress support |
| `--hard-deadline-seconds <n>` | `285` | Absolute tool-call download deadline |
| `--manifest-ttl <seconds>` | `86400` | Manifest freshness age; `0` disables age refresh |
| `--manifest-poll <seconds>` | `300` | Throttled background freshness check |
| `--no-official-mirror` | off | Disable the official CN raw mirror |
| `--no-hedge` | off | Start all download routes immediately |

## Environment variables

| Variable | Equivalent |
|---|---|
| `CODEX_SKILLS_DIR` | `--skills-dir` |
| `CODEX_SKILLS_CACHE_DIR` | `--cache-dir` |
| `CODEX_SKILLS_DOWNLOAD_CONCURRENCY` | `--download-concurrency` |
| `CODEX_SKILLS_DOWNLOAD_TIMEOUT` | `--download-timeout` |
| `CODEX_SKILLS_MANIFEST_POLL_SECONDS` | `--manifest-poll` |
| `CODEX_SKILLS_TOOL_PROFILE` | `--tool-profile` |
| `CODEX_SKILLS_SETTINGS_DIR` | Alternate persisted-settings directory |
| `GITHUB_TOKEN` | GitHub API credential |

## Tool profiles

| Profile | Surface |
|---|---|
| `core` | 8 agent-facing tools and `skill://` resources |
| `full` | Core plus settings, mentions and MCP App tools |
| `auto` | Detect the host after MCP initialization |

`auto` resolves Codex Desktop, ChatGPT and MCP Apps hosts to `full`. Codex CLI
and unknown standard clients resolve to `core`.

## Cache behavior

The cache stores:

- `skills_manifest.json` and validated source metadata;
- immutable catalog responses;
- materialized skill directories with completion markers;
- usage counts and recent read times;
- activity logs under `logs/`.

Changing `--cache-dir` starts with a separate cache. `skill_status` checks local
files without downloading them. A cache entry is replaced only after integrity
checks pass.

## Network behavior

Remote mode uses authoritative GitHub requests for source identity and can use
accelerated mirrors for raw file bodies. Known file content must pass size and
Git blob SHA checks before it is accepted. Authorization headers are attached
only to GitHub-hosted requests.

Disable the built-in official mirror:

```bash
npx -y codex-skills-mcp@latest --no-official-mirror
```

For controlled networks that prefer a deterministic all-route race:

```bash
npx -y codex-skills-mcp@latest --no-hedge
```

## Logs and diagnostics

Remote mode writes daily JSONL activity logs under
`~/.codex-skills-cache/logs/` and keeps 14 days. Local mode mirrors events to
stderr without creating a log file. Tool-level diagnostics are available through
the `diagnostics` tool.
