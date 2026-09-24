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
    "STEP 1 DISCOVER of the agent protocol. Given a task description, returns an ordered multi-skill execution plan draft (skills carry a [cached] badge when already on local disk — prefer them when scores are close). After planning you MUST call read_skill for EVERY skill in your final plan — each call downloads the complete skill — before starting work.",
    {
      task_description: z.string().describe("Full description of the task to accomplish, e.g. '把技术博客文章转换成小红书图文并发布'"),
    },
    async ({ task_description }) =>
      withToolLogging("plan_workflow", { task_description }, async () => {
        // Throttled freshness poll so newly integrated skills appear in plans
        if (typeof searchEngine.maybeRefreshManifest === "function") {
          await searchEngine.maybeRefreshManifest();
        }

        // Use a broader search to find related skills
        const results = searchEngine.search(task_description, { limit: 15 });

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

        // Group by category for better overview
        const byCategory = new Map<string, typeof results>();
        for (const r of results) {
          const list = byCategory.get(r.category) || [];
          list.push(r);
          byCategory.set(r.category, list);
        }

        let output = `## Workflow Plan for:\n> ${task_description}\n\n`;
        output += `Found ${results.length} potentially relevant skills.\n\n`;

        // Suggested ordered plan draft (top 5) — the agent adjusts as needed
        const topSkills = results.slice(0, 5);
        if (topSkills.length > 0) {
          output += "### 🧭 Suggested plan draft (adjust to your task, keep the set minimal)\n";
          topSkills.forEach((s, i) => {
            output += `${i + 1}. **${s.name}**${badge(s.name)} — ${s.description.substring(0, 140)}...`;
            if (i < topSkills.length - 1) output += ` -> `;
            output += "\n";
          });
          output += "\n";
        }

        // All by category
        output += "### 📂 By Category\n";
        for (const [category, skills] of byCategory) {
          output += `\n**${category}**:\n`;
          for (const s of skills) {
            output += `  - ${s.name}${badge(s.name)} (score: ${s.score})\n`;
          }
        }

        output += "\n---\n";
        output += FOOTER_PLAN;

        return {
          content: [{ type: "text" as const, text: output }],
        };
      })
  );
}
