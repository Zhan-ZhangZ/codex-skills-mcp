import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";

export function registerSearchSkills(
  server: McpServer,
  searchEngine: SkillSearchEngine
): void {
  server.tool(
    "search_skills",
    "Search the codex-skills library by natural language query. Returns matching skills ranked by relevance. Use this as the primary entry point to discover skills for a task.",
    {
      query: z.string().describe("Natural language description of what you need, e.g. '前端性能优化' or 'video subtitle translation'"),
      category: z.string().optional().describe("Optional category filter, e.g. '05_多媒体与设计资产'"),
      limit: z.number().optional().default(8).describe("Max number of results to return (default: 8)"),
      force_refresh: z.boolean().optional().describe("If true, forcefully refreshes the remote skills list cache. Use this when the user just integrated a new skill and it's not showing up."),
    },
    async ({ query, category, limit, force_refresh }) => {
      let results = searchEngine.search(query, { category, limit });

      // Auto-refresh if explicitly requested or if no results are found (might be a newly added skill)
      if (force_refresh || results.length === 0) {
        if (typeof searchEngine.refreshManifest === "function") {
          console.error(`[codex-skills-mcp] ${force_refresh ? 'Explicitly' : 'Automatically'} refreshing manifest for query: "${query}"`);
          const refreshed = await searchEngine.refreshManifest();
          if (refreshed) {
            results = searchEngine.search(query, { category, limit });
          }
        }
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No skills found matching "${query}". Try broader keywords or use list_categories to browse available skills.`,
            },
          ],
        };
      }

      const formatted = results
        .map((r, i) => {
          const hit =
            Array.isArray(r.matched_terms) && r.matched_terms.length > 0
              ? `\n   命中: ${r.matched_terms.join("、")}`
              : "";
          return `${i + 1}. **${r.name}** [${r.category}] (score: ${r.score})\n   ${r.description.substring(0, 200)}${r.description.length > 200 ? "..." : ""}${hit}`;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} matching skills:\n\n${formatted}\n\nUse read_skill(name) to load a skill's full instructions.`,
          },
        ],
      };
    }
  );
}
