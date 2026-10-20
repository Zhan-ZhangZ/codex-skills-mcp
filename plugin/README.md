# Codex Skills plugin

This directory is the installable Codex plugin surface for
[codex-skills-mcp](https://github.com/Zhan-ZhangZ/codex-skills-mcp).

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
