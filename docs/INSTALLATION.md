# Installation

Codex Skills MCP supports Node.js 22 or newer and two transport modes:

- **stdio** for local desktop and CLI clients;
- **Streamable HTTP** for remote clients and controlled self-hosting.

## Host capability matrix

| Host | Core MCP tools | Visual library / `skills.tray` | `@` mentions / settings UI |
|---|---:|---:|---:|
| ChatGPT desktop app with the local plugin | Yes | Yes | Yes |
| Codex desktop app | Yes | Yes | Yes |
| Codex CLI | Yes | No | No |
| Claude Desktop, Cursor and Windsurf | Yes | No | No |
| Compatible remote MCP Apps host | Yes | Host-dependent | Host-dependent |

技能托盘（`skills.tray`）不是标准 MCP 协议的一部分。本项目本地插件安装后，
可视技能库与技能托盘需要在支持 MCP Apps 的 ChatGPT 桌面端或 Codex 桌面端中
使用；Codex CLI、Claude Desktop、Cursor 和 Windsurf 不会显示这套 UI。
ChatGPT 本地插件只应在本地执行线程中使用，`@` 提及不会出现在云端线程。

The visual skill tray is **not** a standard MCP feature. The bundled local
plugin is desktop-only and is installed from the ChatGPT desktop app. Standard
MCP clients use the 8 core tools and `skill://` resources without a custom UI.

## stdio with `npx`

The simplest installation requires no global package:

```bash
npx -y codex-skills-mcp@beta
```

`main` currently tracks the 1.5.0 beta line. The `beta` dist-tag matches these
features; `latest` remains on stable 1.4.2 until the 1.5 line is promoted.

The first run downloads the manifest, builds a local search index, and creates
the cache directory at `~/.codex-skills-cache`.

## Codex

Codex CLI exposes the standard core tool surface. The fullscreen library and
conversation-side skill tray appear in the Codex desktop app, not in the CLI.

```bash
codex mcp add codex-skills -- npx -y codex-skills-mcp@beta
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.codex-skills]
command = "npx"
args = ["-y", "codex-skills-mcp@beta"]
```

## Claude Desktop

Add the following to
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS:

```json
{
  "mcpServers": {
    "codex-skills": {
      "command": "npx",
      "args": ["-y", "codex-skills-mcp@beta"]
    }
  }
}
```

Claude Desktop receives the core tools/resources only. It does not provide the
ChatGPT/Codex MCP Apps skill tray.

## Cursor

Add `.cursor/mcp.json` to the project:

```json
{
  "mcpServers": {
    "codex-skills": {
      "command": "npx",
      "args": ["-y", "codex-skills-mcp@beta"]
    }
  }
}
```

Cursor receives the core tools/resources only. It does not render the skill
tray UI.

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
