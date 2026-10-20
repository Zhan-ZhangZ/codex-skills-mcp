# Installation

Codex Skills MCP supports Node.js 22 or newer and two transport modes:

- **stdio** for local desktop and CLI clients;
- **Streamable HTTP** for remote clients and controlled self-hosting.

## stdio with `npx`

The simplest installation requires no global package:

```bash
npx -y codex-skills-mcp@latest
```

The first run downloads the manifest, builds a local search index, and creates
the cache directory at `~/.codex-skills-cache`.

## Codex

```bash
codex mcp add codex-skills -- npx -y codex-skills-mcp@latest
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.codex-skills]
command = "npx"
args = ["-y", "codex-skills-mcp@latest"]
```

## Claude Desktop

Add the following to
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

```json
{
  "mcpServers": {
    "codex-skills": {
      "command": "npx",
      "args": ["-y", "codex-skills-mcp@latest"]
    }
  }
}
```

## Cursor

Add `.cursor/mcp.json` to the project:

```json
{
  "mcpServers": {
    "codex-skills": {
      "command": "npx",
      "args": ["-y", "codex-skills-mcp@latest"]
    }
  }
}
```

## Windsurf and VS Code MCP clients

Use the same `command`/`args` pair as the Cursor example. Clients that support
standard MCP resources can read `skill://{name}` even when the full app surface
is hidden.

## Local skill library

For offline development or a custom catalog:

```bash
git clone https://github.com/Zhan-ZhangZ/codex-skills-mcp.git
cd codex-skills-mcp
npm ci
npm run build
node dist/index.js --skills-dir /path/to/codex-skills
```

The local directory must contain `skills_manifest.json`.

## HTTP transport

```bash
node dist/index.js --http --port 3456
```

Endpoints:

- MCP: `http://127.0.0.1:3456/mcp`
- Health: `http://127.0.0.1:3456/health`

For listening beyond the local machine:

```bash
node dist/index.js \
  --http \
  --host 0.0.0.0 \
  --port 3456 \
  --allowed-hosts skills.example.com
```

Do not expose an unauthenticated instance directly to the public internet.
Place it behind TLS, authentication and rate limiting appropriate to your
deployment.

## Verification

```bash
curl http://127.0.0.1:3456/health
```

Expected shape:

```json
{
  "status": "ok",
  "name": "codex-skills-mcp",
  "version": "1.5.0-beta.14",
  "skills": 298
}
```

Skill and category counts change as the source catalog updates.

## Troubleshooting

| Symptom | Action |
|---|---|
| Client does not show the server | Restart the client or MCP session after changing config |
| First launch is slow | Wait for the npm package and manifest cache to initialize |
| Tool list differs by client | Check `--tool-profile`; standard clients expose 8 tools |
| A skill read is interrupted | Retry it; verified files resume from the local cache |
| HTTP request is rejected | Add the public hostname to `--allowed-hosts` |
| Local mode cannot find skills | Pass `--skills-dir` or set `CODEX_SKILLS_DIR` |

Run the `diagnostics` tool for recent tool calls, download errors and cache
health.
