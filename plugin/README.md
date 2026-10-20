# Codex Skills plugin

This directory is the installable Codex plugin surface for
[codex-skills-mcp](https://github.com/Zhan-ZhangZ/codex-skills-mcp).

The plugin uses a local stdio MCP server and is marked
`requires_local_executor`. Its visual skill library, `skills.tray` panel,
attachment handoff and settings UI are available in supported ChatGPT/Codex
desktop hosts only. Codex CLI, Claude Desktop, Cursor and other standard clients
use the server's core tools and resources without this custom UI.

It bundles:

- the MCP server entrypoint;
- the interactive MCP App;
- the official icon;
- the repository license and NOTICE.

Rebuild the distribution from the repository root:

```bash
npm run build:plugin
```

Do not edit `dist/server.js` or `dist/app.html` by hand. Both files are generated
from `src/` and `app-src/`.
