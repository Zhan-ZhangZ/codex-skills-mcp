import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { FOOTER_PLAN, CACHED_BADGE } from "../lib/protocol.js";
import { withToolLogging } from "../lib/logger.js";

export function registerPlanWorkflow(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "plan_workflow",
    "Return a ranked skill shortlist for a task with confidence and match reasons. Candidates are optional; choose the smallest relevant set or none.",
    {
      task_description: z.string().trim().min(1).max(8000).describe("Full description of the task to accomplish, e.g. '把技术博客文章转换成小红书图文并发布'"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ task_description }) =>
      withToolLogging("plan_workflow", { task_description }, async () => {
        // Throttled freshness poll so newly integrated skills appear in plans
        if (typeof searchEngine.maybeRefreshManifest === "function") {
          void searchEngine.maybeRefreshManifest();
        }

        // Task mode separates deliverables ("PPT") from incidental words
        // ("boss asked me") and returns explainable candidates.
        const page = searchEngine.searchWithTotal(task_description, { mode: "task", limit: 15 });
        const results = page.results;

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No skills found for this task. Consider breaking it down into smaller sub-tasks and searching individually with search_skills. If you proceed without any skill, say so explicitly in your final answer.`,
              },
            ],
          };
        }

        const badge = (name: string) => {
          const entry = searchEngine.findByName(name);
          return entry && loader.isCached(entry) ? ` ${CACHED_BADGE}` : "";
        };

        const topSkills = results.slice(0, 5);
        const others = results.slice(5);
        let output = `## Skill candidates for:\n> ${task_description}\n\n`;
        output += `Found ${page.total} candidate skill${page.total === 1 ? "" : "s"}. These are suggestions, not a required sequence.\n\n`;

        if (topSkills.length > 0) {
          output += "### 🧭 Best fits\n";
          topSkills.forEach((s, i) => {
            const confidence = s.confidence_label
              ? ` · confidence: ${s.confidence_label} (${s.confidence?.toFixed(2)})`
              : "";
            const size = s.size_bytes !== undefined
              ? ` · ${(s.size_bytes / (1024 * 1024)).toFixed(s.size_bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
              : "";
            output += `${i + 1}. **${s.name}**${badge(s.name)} [${s.category}]${confidence}${size}\n`;
            output += `   ${s.description.substring(0, 140)}${s.description.length > 140 ? "..." : ""}\n`;
            if (s.match_reasons?.length) output += `   为什么: ${s.match_reasons.join("、")}\n`;
            output += "\n";
          });
        }

        if (others.length > 0) {
          output += "### Other candidates\n";
          for (const s of others) {
            output += `- ${s.name}${badge(s.name)} [${s.category}]`;
            if (s.confidence_label) output += ` · ${s.confidence_label}`;
            output += "\n";
          }
          output += "\n";
        }

        output += "### Agent decision\n";
        output += "- Select only the candidates that materially help this task; candidates may overlap or be alternatives.\n";
        output += "- You may ignore every candidate if the task is better served directly; no skill is mandatory.\n";
        output += "- If you use a skill, call read_skill for that skill before executing it. Do not load every candidate just because it was returned.\n";

        output += "\n---\n";
        output += FOOTER_PLAN;

        return {
          content: [{ type: "text" as const, text: output }],
        };
      })
  );
}
