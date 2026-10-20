# Host Extensions

Codex Skills MCP uses standard MCP first. Rich host integrations are additive and
can be ignored by clients that do not support them.

## OpenAI MCP extensions

| Capability | Details |
|---|---|
| `settings.read` | Returns the settings schema, current values and layout |
| `settings.update` | Applies validated increments and persists them |
| `refresh_skills_list` | Refreshes the remote manifest immediately |
| `search_mentions` | Supplies resource links for composer `@` mentions |
| `skill://{name}` | Resolves a skill's `SKILL.md` |
| `skill://{name}/{+path}` | Resolves supporting files |
| `openai/settings` | Advertised through the extension capability |

Persisted settings live in `~/.codex-skills-mcp/settings.json` and apply on the
next process start. Runtime updates take effect immediately.

## MCP Apps

The App bridge registers two host entrypoints:

- `skills.library` for the fullscreen library;
- `skills.tray` for a side panel attached to the current conversation.

The app can browse categories, search, inspect detail and files, track download
progress, attach complete skill instructions to the next message, remove an
attachment, clear one skill cache and reuse shared search history.

App-only tools are marked with host visibility metadata so standard models do
not see UI controls as callable tools.

## Compatibility

Unknown `_meta` keys and extension capabilities are ignored by standard MCP
clients. Codex CLI and generic clients receive `core` by default; Codex Desktop,
ChatGPT and MCP Apps hosts resolve to `full`.

Test coverage includes both profiles and verifies that `skill://` resources stay
available in `core` mode.
