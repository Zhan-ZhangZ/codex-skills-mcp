# Codex Skills plugin

This directory is the GitHub-marketplace distribution surface for
[codex-skills-mcp](https://github.com/Zhan-ZhangZ/codex-skills-mcp).

Install it from Codex:

```bash
codex plugin marketplace add Zhan-ZhangZ/codex-skills-mcp --ref main
codex plugin add codex-skills@codex-skills-marketplace
```

No separate Node.js, npm or npx installation is required. The POSIX and Windows
launchers resolve the runtime supplied by the Codex desktop app and start the
bundled stdio server. System `node` is only a last-resort development fallback.

The plugin is marked `requires_local_executor` and is desktop-only. Its visual
skill library, `skills.tray` panel, attachment handoff and settings UI require a
host that supports MCP Apps and OpenAI extensions. Start a new chat after
installation.

It bundles:

- the MCP server entrypoint;
- the interactive MCP App;
- cross-platform runtime launchers;
- the official icon;
- the repository license and NOTICE.

Rebuild the distribution from the repository root:

```bash
npm run build:plugin
```

Do not edit `dist/server.js` or `dist/app.html` by hand. Both files are generated
from `src/` and `app-src/`. The build also synchronizes all plugin manifest
versions with the root `package.json`.

Verify with:

```bash
npm run build:plugin
npm run check:plugin
node --test test/plugin-runtime.test.mjs
```
