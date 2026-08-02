import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";

export function registerListCategories(
  server: McpServer,
  searchEngine: SkillSearchEngine
): void {
  server.tool(
    "list_categories",
    "List all skill categories in the codex-skills library with their skill counts. Use this to get an overview of available domains.",
    {},
    async () => {
      const categories = searchEngine.getCategories();

      const formatted = categories
        .map((c) => `- **${c.name}**: ${c.skill_count} skills`)
        .join("\n");

      const total = categories.reduce((sum, c) => sum + c.skill_count, 0);

      return {
        content: [
          {
            type: "text" as const,
            text: `Codex-Skills Library: ${total} skills across ${categories.length} categories\n\n${formatted}\n\nUse search_skills(query) to find skills, or search_skills(query, category) to filter by category.`,
          },
        ],
      };
    }
  );
}
