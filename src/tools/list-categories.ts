import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import { withToolLogging } from "../lib/logger.js";

export function registerListCategories(
  server: McpServer,
  searchEngine: SkillSearchEngine
): void {
  server.tool(
    "list_categories",
    "List skill categories and their counts. Use when browsing by domain or when a search is too broad.",
    {},
    { readOnlyHint: true },
    async () =>
      withToolLogging("list_categories", {}, async () => {
        const categories = searchEngine.getCategories();

        const formatted = categories
          .map((c) => `- **${c.name}**: ${c.skill_count} skills`)
          .join("\n");

        const total = categories.reduce((sum, c) => sum + c.skill_count, 0);

        return {
          content: [
            {
              type: "text" as const,
              text: `Codex-Skills Library: ${total} skills across ${categories.length} categories\n\n${formatted}\n\nUse search_skills(keywords) or plan_workflow(task) to discover skills. If you choose one, call read_skill for that skill; no skill is required.`,
            },
          ],
        };
      })
  );
}
