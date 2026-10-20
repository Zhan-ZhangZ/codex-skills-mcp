# Agent Protocol

Codex Skills MCP exposes a recommended discovery flow, not a mandatory workflow.
The same guidance is available through MCP server instructions, tool
descriptions and compact result footers.

## Principles

- Search is a discovery step; results are candidates, not commands.
- The agent decides whether a skill is relevant.
- Download only the skills selected for the current task.
- Read the selected `SKILL.md` before using its scripts or references.
- The agent may complete a task without any skill when that is the better answer.

## Two search modes

| Mode | Best for | Example |
|---|---|---|
| Keyword | Known skill names, products and short concepts | `PPT`, `合同审查` |
| Task | Whole user requests with a deliverable | `把技术博客做成小红书图文` |

`search_skills(mode="auto")` selects the path from query shape. `plan_workflow`
is an alternate task-oriented shortlist endpoint.

## Recommended flow

1. **Discover** — Search by keyword or task, or call `plan_workflow`.
2. **Select** — Pick the smallest relevant skill set, including none.
3. **Materialize** — Call `read_skill` only for selected skills and keep the
   returned `local_path`.
4. **Execute** — Follow the materialized `SKILL.md`; run scripts from the cache
   unless the skill says otherwise.
5. **Verify and report** — Use `skill_status` when integrity matters and
   `diagnostics` when a download or call fails.

`[cached]` means the skill is already present locally. It does not mean the skill
is automatically applicable.

## Anti-patterns

- Loading every search result “just in case”;
- treating `plan_workflow` as a fixed sequence;
- reading a skill that the agent will not use;
- ignoring prerequisites in `SKILL.md`;
- reporting a skill as used when it was only downloaded.

## Surface profiles

- `core`: 8 agent tools and `skill://` resources.
- `full`: core plus settings, mention and MCP App tools.
- `auto`: choose from the host identity after initialization.
