import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import { withToolLogging } from "../lib/logger.js";

export function registerListCategories(
  server: McpServer,
  searchEngine: SkillSearchEngine
): void {
  server.tool(
    "list_categories",
    "List all skill categories in the codex-skills library with their skill counts. Use it to get an overview of available domains before searching (agent protocol step 1 DISCOVER).",
    {},
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
              text: `Codex-Skills Library: ${total} skills across ${categories.length} categories\n\n${formatted}\n\nUse search_skills(query) or plan_workflow(task_description) to DISCOVER skills; results carry a [cached] badge for skills already on local disk. Then read_skill EVERY selected skill before starting work.`,
            },
          ],
        };
      })
  );
}
