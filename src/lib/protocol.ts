/**
 * Agent protocol texts — the single source of truth for the behavioral
 * contract enforced across three surfaces: server `instructions`, tool
 * descriptions, and tool-result footers. Keep the wording consistent here so
 * every surface reinforces the same 5-step protocol (docs/AGENT-PROTOCOL.md).
 */

/** Server-level instructions returned in the MCP initialize result. */
export const SERVER_INSTRUCTIONS = `Codex-Skills: a live library of expert skills fetched on demand — no pre-install needed. Daily use progressively caches skills locally.

Suggested discovery workflow (use it when a skill materially helps; you remain free to skip it):
1. DISCOVER — search_skills(keywords) for known-item lookup, or plan_workflow(task) / search_skills(task, mode="task") for a full request. "[cached]" means the skill is already on local disk; prefer cached skills when scores are close.
2. SELECT — choose the smallest set of skills that together cover the task.
3. MATERIALIZE — for each skill you actually select, call read_skill(name). It downloads the complete skill (SKILL.md, scripts, configs, references) and returns the instructions plus local_path.
4. EXECUTE — when you choose to use a skill, follow its SKILL.md and run its scripts from local_path when applicable. You may adapt or decline a skill if it conflicts with the user's request or the task is better served directly.
5. VERIFY & REPORT — skill_status(names) is available when cache completeness matters; report which skills you used. On failures, use diagnostics.

Do not load a skill merely because a search result exists. If no candidate fits, state that you proceeded without a skill.`;

/** search_skills result footer. */
export const FOOTER_SEARCH = `▶ NEXT (optional): if one or more candidates materially help, call read_skill for only the skills you select. If none fit, proceed without a skill and say so; loading every result is not required.`;

/** plan_workflow result footer. */
export const FOOTER_PLAN = `▶ NEXT (optional): these are candidates, not a mandatory sequence. Choose the smallest set that materially helps, then call read_skill only for those skills. Ignore overlapping or irrelevant candidates and proceed directly when no skill fits.`;

/** read_skill result footer (after the Cache & Execution section). */
export const FOOTER_READ = `▶ STEP 4: Execute the task by following the Instructions above when you choose to use this skill — run scripts from local_path when applicable. If the skill is incomplete or conflicts with the user's request, explain and adapt instead of forcing it. Use load_skill_file when you need additional files.`;

/** skill_status result footer. */
export const FOOTER_STATUS = `▶ If a skill you chose is complete, you may execute from its local_path. Incomplete skills: re-call read_skill to resume the download, or proceed without that skill if it is not essential.`;

/** diagnostics result footer. */
export const FOOTER_DIAGNOSTICS = `▶ Fix the reported errors (network failures are often transient — retry read_skill), then resume the protocol at the failed step.`;

/** Cached badge used in search/plan results. */
export const CACHED_BADGE = "[cached]";
