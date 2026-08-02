import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";

export function registerPlanWorkflow(
  server: McpServer,
  searchEngine: SkillSearchEngine
): void {
  server.tool(
    "plan_workflow",
    "Given a task description, suggest relevant skills that could be combined to accomplish it. Returns a list of recommended skills — the actual orchestration and execution order should be decided by you (the Agent).",
    {
      task_description: z.string().describe("Full description of the task to accomplish, e.g. '把技术博客文章转换成小红书图文并发布'"),
    },
    async ({ task_description }) => {
      // Use a broader search to find related skills
      const results = searchEngine.search(task_description, { limit: 15 });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No skills found for this task. Consider breaking it down into smaller sub-tasks and searching individually.`,
            },
          ],
        };
      }

      // Group by category for better overview
      const byCategory = new Map<string, typeof results>();
      for (const r of results) {
        const list = byCategory.get(r.category) || [];
        list.push(r);
        byCategory.set(r.category, list);
      }

      let output = `## Workflow Suggestions for:\n> ${task_description}\n\n`;
      output += `Found ${results.length} potentially relevant skills:\n\n`;

      // Top recommendations (score > 3)
      const topSkills = results.filter((r) => r.score > 3);
      if (topSkills.length > 0) {
        output += "### 🎯 Top Recommendations\n";
        for (const s of topSkills) {
          output += `- **${s.name}** (score: ${s.score}) — ${s.description.substring(0, 150)}...\n`;
        }
        output += "\n";
      }

      // All by category
      output += "### 📂 By Category\n";
      for (const [category, skills] of byCategory) {
        output += `\n**${category}**:\n`;
        for (const s of skills) {
          output += `  - ${s.name} (score: ${s.score})\n`;
        }
      }

      output += "\n---\n";
      output +=
        "Use read_skill(name) to load each skill's instructions. " +
        "You should determine the execution order and how to chain the skills based on your task analysis.";

      return {
        content: [{ type: "text" as const, text: output }],
      };
    }
  );
}
