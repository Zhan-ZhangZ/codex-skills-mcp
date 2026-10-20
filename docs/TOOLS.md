# Tool Reference

The server registers up to 22 tools. Standard clients normally receive the 8
core tools; MCP Apps hosts may receive the complete surface.

## Core tools

### `search_skills`

```json
{
  "query": "PPT",
  "mode": "auto | keyword | task",
  "category": "05_多媒体与设计资产",
  "limit": 8
}
```

Returns ranked candidates, confidence, match reasons, cache state and known size.

### `plan_workflow`

Takes a task description and returns a shortlist of potentially useful skills
with reasoning. The result is advisory rather than a mandatory execution order.

### `read_skill`

```json
{ "name": "MediaCrawler" }
```

Materializes the selected skill and returns its `SKILL.md`, dependencies,
display data, bounded navigation and `local_path`.

### `load_skill_file`

Reads a supporting file from a materialized skill. Large text is returned in
UTF-8 byte ranges.

```json
{
  "skill_name": "KrillinAI",
  "file_path": "README.md",
  "offset": 0,
  "max_bytes": 524288
}
```

### `list_skill_files`

Browses files or nested skills with pagination and signed cursors.

### `skill_status`

Checks one or more cache entries for missing, incomplete or complete files.

### `list_categories`

Returns current categories and skill counts.

### `diagnostics`

Returns recent activity, recent errors, cache totals, manifest freshness and
effective configuration.

## OpenAI extension tools

| Tool | Availability | Purpose |
|---|---|---|
| `settings.read` | `full` | Read settings schema and current values |
| `settings.update` | `full` | Validate and persist settings updates |
| `refresh_skills_list` | `full` | Refresh the remote manifest immediately |
| `search_mentions` | Host-defined | Provide `@` mention candidates |

## App-only tools

These tools are hidden from models where the host supports app visibility:

> The visual library, `skills.tray`, attachment handoff and settings surfaces
> require a ChatGPT or Codex desktop host with MCP Apps support. Codex CLI,
> Claude Desktop, Cursor and other standard MCP clients expose only the core
> tools and resources.

| Tool | Purpose |
|---|---|
| `skills.library` | Open the fullscreen library |
| `skills.tray` | Open the conversation-side skill tray |
| `skills.browse` | Read category/home data |
| `skills.query` | Keyword query for the UI |
| `skills.getSearchHistory` | Read shared search history |
| `skills.recordSearch` | Add a shared history item |
| `skills.clearSearchHistory` | Clear shared history |
| `skills.progress` | Read current materialization progress |
| `skills.previewImage` | Render a supported image from a cached skill |
| `skills.clearCache` | Remove one skill cache while retaining usage history |

## Resources

`skill://{name}` resolves to a materialized `SKILL.md`.
`skill://{name}/{+path}` resolves supporting files such as scripts, references
and README files. Resources remain available in `core` mode because they are
not model-callable tools.

`resources/list` advertises the MCP App resource, the library router and every
indexed skill URI so hosts can resolve `@` references. The catalog size follows
the live manifest and may contain hundreds of resources; entries intentionally
omit descriptions to keep host-side resource registry context bounded.
