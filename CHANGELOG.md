# Changelog

All notable public changes are recorded here. Format follows Keep a Changelog,
and versions follow SemVer.

## [1.5.0-beta.14] - 2026-10-20

### Added

- Dedicated MCP Apps host detection for `codex-mcp-client`, Codex Desktop and
  ChatGPT, preserving mentions, the skill tray and the full tool profile.
- Official brand assets, a commercial attribution template and explicit
  commercial redistribution terms.

### Changed

- Project documentation is organized around installation, configuration,
  architecture, tool contracts, security and release workflows.
- Standard clients receive the focused 8-tool surface; MCP Apps hosts retain the
  complete 22-tool surface.

## [1.5.0-beta.13] - 2026-10-19

### Added

- Keyword and task search modes with confidence and match explanations.
- `--tool-profile auto|core|full` and `CODEX_SKILLS_TOOL_PROFILE`.
- UI keyword guidance and a clearer three-step skill handoff.

### Fixed

- Mixed CJK/Latin queries retain Latin product and deliverable terms.
- Multi-character searches no longer accept single-character noise matches.
- Toolkit read-only annotations now reflect cache and manifest writes.

## [1.5.0-beta.12] - 2026-10-18

### Added

- Cross-session search history shared by the sidebar, tray and conversations.
- Attached-skill management with per-item removal and clear-all.
- Full-skill handoff with local path, resource link and structured metadata.
