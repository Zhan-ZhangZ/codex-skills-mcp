# GitHub plugin marketplace

Codex Skills can be distributed as a Codex desktop plugin backed by this GitHub
repository. Installing the plugin prepares the complete local MCP runtime: the
dependency-bundled server, MCP App, manifests and cross-platform launchers are
already in the package.

Plugin users do not need to install Node.js, npm or npx.

## Install

Add this repository as a marketplace once:

```bash
codex plugin marketplace add Zhan-ZhangZ/codex-skills-mcp --ref main
```

Install **Codex Skills** from the Plugins directory, or run:

```bash
codex plugin add codex-skills@codex-skills-marketplace
```

Start a new chat after installation so Codex loads the MCP tools and MCP App.

## Runtime model

```text
Codex marketplace
  -> installs plugin into the Codex plugin cache
  -> launches scripts/launch-codex-skills-mcp[.cmd]
  -> resolves the bundled Codex Node runtime
  -> starts dist/server.js over stdio
```

The launcher checks, in order:

1. `CODEX_MCP_NODE_PATH`;
2. `CODEX_BROWSER_USE_NODE_PATH`;
3. the Codex application resources directory;
4. the Codex runtime cache;
5. `node` on `PATH` as a development fallback.

The Codex-compatible manifest forwards those runtime variables to the plugin
process. The portable `mcp.json` keeps `${PLUGIN_ROOT}` and the standard stdio
transport declaration, so the server is not resolved through npm.

`CODEX_MCP_NODE_PATH` is currently used by OpenAI's own bundled desktop plugins.
It is not documented as a permanent third-party ABI, so each release must keep
the launcher fallbacks and run the clean-install test.

## Supported hosts

The plugin is Desktop only and requires a local Codex executor:

- Codex desktop on macOS;
- Codex desktop on Windows;
- supported Codex desktop builds on Linux.

The visual library, `skills.tray`, mentions and settings panel require an MCP
Apps-capable desktop host. Codex CLI and other standard MCP clients should keep
using the standalone stdio or HTTP installation.

## Update and pin

Update the marketplace snapshot and reinstall the plugin:

```bash
codex plugin marketplace upgrade codex-skills-marketplace
codex plugin add codex-skills@codex-skills-marketplace
```

Pin a known release:

```bash
codex plugin marketplace remove codex-skills-marketplace
codex plugin marketplace add Zhan-ZhangZ/codex-skills-mcp --ref plugin-v1.6.2
codex plugin add codex-skills@codex-skills-marketplace
```

Pinned marketplace sources do not move when `main` changes. Release tags are
immutable and are attached to the checked plugin archive by GitHub Actions.

## Versioning

The root `package.json` is the single source of truth for the program version.
`npm run build:plugin` synchronizes it into:

- `plugin/package.json`;
- `plugin/plugin.json`;
- `plugin/.codex-plugin/plugin.json`.

Skill content remains independently versioned by the remote catalog revision
and per-file digest. A skill catalog update does not require a new plugin
release.

Create releases with:

```bash
git tag plugin-v1.6.2
git push origin main plugin-v1.6.2
```

## Verification

Repository checks:

```bash
npm run build:plugin
npm run check:plugin
node --test test/plugin-runtime.test.mjs
npm run check:package
```

The plugin runtime test uses a minimal `PATH` with `node` unavailable, supplies
only a Codex-style runtime path, and verifies:

- launcher startup;
- MCP initialization;
- server version;
- tool discovery;
- `search_skills`;
- clean process shutdown.

## Public plugin directory

This repository's `.agents/plugins/marketplace.json` is a GitHub-backed Codex
marketplace. It is separate from the universal OpenAI Plugin Directory.

Public distribution of a local stdio MCP requires OpenAI review and partner
eligibility for local MCP submissions. A future public listing should either:

- obtain that approval and distribute a clean desktop-only package; or
- provide a remote HTTPS MCP variant for cross-surface use.

The GitHub marketplace remains the immediate private/team distribution channel.
