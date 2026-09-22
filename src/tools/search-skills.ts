import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { FOOTER_SEARCH, CACHED_BADGE } from "../lib/protocol.js";
import { withToolLogging } from "../lib/logger.js";

export function registerSearchSkills(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "search_skills",
    "STEP 1 DISCOVER of the agent protocol. Search the codex-skills library by natural language query; results are ranked and carry a [cached] badge when the skill is already fully downloaded on local disk — prefer cached skills when scores are close. After selecting skills you MUST materialize each one with read_skill (downloads the COMPLETE skill) before starting the task.",
    {
      query: z.string().describe("Natural language description of what you need, e.g. '前端性能优化' or 'video subtitle translation'"),
      category: z.string().optional().describe("Optional category filter, e.g. '05_多媒体与设计资产'"),
      limit: z.number().optional().default(8).describe("Max number of results to return (default: 8)"),
      force_refresh: z.boolean().optional().describe("If true, forcefully refreshes the remote skills list cache. Use this when the user just integrated a new skill and it's not showing up."),
    },
    async ({ query, category, limit, force_refresh }) =>
      withToolLogging("search_skills", { query, category, limit, force_refresh }, async () => {
        let results = searchEngine.search(query, { category, limit });

        // Auto-refresh if explicitly requested or if no results are found (might be a newly added skill)
        if (force_refresh || results.length === 0) {
          if (typeof searchEngine.refreshManifest === "function") {
            console.error(`[codex-skills-mcp] ${force_refresh ? "Explicitly" : "Automatically"} refreshing manifest for query: "${query}"`);
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
                text: `No skills found matching "${query}". Try broader keywords or use list_categories to browse available skills. If you proceed without a skill, say so explicitly in your final answer.`,
              },
            ],
          };
        }

        const formatted = results
          .map((r, i) => {
            const entry = searchEngine.findByName(r.name);
            const badge = entry && loader.isCached(entry) ? ` ${CACHED_BADGE}` : "";
            const hit =
              Array.isArray(r.matched_terms) && r.matched_terms.length > 0
                ? `\n   命中: ${r.matched_terms.join("、")}`
                : "";
            return `${i + 1}. **${r.name}**${badge} [${r.category}] (score: ${r.score})\n   ${r.description.substring(0, 200)}${r.description.length > 200 ? "..." : ""}${hit}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} matching skills:\n\n${formatted}\n\n${FOOTER_SEARCH}`,
            },
          ],
        };
      })
  );
}
