/**
 * Agent protocol texts — the single source of truth for the behavioral
 * contract enforced across three surfaces: server `instructions`, tool
 * descriptions, and tool-result footers. Keep the wording consistent here so
 * every surface reinforces the same 5-step protocol (docs/AGENT-PROTOCOL.md).
 */

/** Server-level instructions returned in the MCP initialize result. */
export const SERVER_INSTRUCTIONS = `Codex-Skills: 190+ expert skills fetched on demand — no pre-install needed. Daily use progressively caches skills locally.

MANDATORY 5-step protocol for any task a skill could help with:
1. DISCOVER — plan_workflow(task) and/or search_skills(query). "[cached]" means the skill is already on local disk; prefer cached skills when scores are close.
2. SELECT — choose the smallest set of skills that together cover the task.
3. MATERIALIZE — call read_skill(name) for EVERY selected skill BEFORE starting work. Each call downloads the COMPLETE skill (SKILL.md, scripts, configs, references) into the local cache and returns the instructions plus local_path. Never skip or partial-skip this step.
4. EXECUTE — follow each loaded SKILL.md verbatim and run its scripts from local_path (run its Setup command first if one is listed). NEVER improvise a substitute for a loaded skill. load_skill_file is only for reading extra files.
5. VERIFY & REPORT — skill_status(names) confirms cache completeness; report which skills you used. On failures, use diagnostics.

Forbidden anti-patterns: reading SKILL.md and then doing the task from general knowledge; starting before every selected skill is materialized; rewriting a loaded skill's logic yourself.`;

/** search_skills result footer. */
export const FOOTER_SEARCH = `▶ PROTOCOL STEP 3 (required): call read_skill(name) for EVERY skill you select — each call downloads the complete skill to local disk (cached skills return instantly). Do NOT start the task until all selected skills are loaded; then execute strictly per each SKILL.md.`;

/** plan_workflow result footer. */
export const FOOTER_PLAN = `▶ PROTOCOL STEP 3 (required): call read_skill for EVERY skill in your final plan before starting — each call downloads the complete skill to local disk (cached skills return instantly). Then execute in the planned order, strictly following each SKILL.md, and report which skills you used.`;

/** read_skill result footer (after the Cache & Execution section). */
export const FOOTER_READ = `▶ PROTOCOL STEP 4: Execute the task by following the Instructions above exactly — run scripts from local_path. Do NOT improvise a substitute for this skill. Use load_skill_file only when you need additional files.`;

/** skill_status result footer. */
export const FOOTER_STATUS = `▶ If all selected skills are complete, proceed to EXECUTE from each local_path. Incomplete skills: re-call read_skill to resume the download.`;

/** diagnostics result footer. */
export const FOOTER_DIAGNOSTICS = `▶ Fix the reported errors (network failures are often transient — retry read_skill), then resume the protocol at the failed step.`;

/** Cached badge used in search/plan results. */
export const CACHED_BADGE = "[cached]";
