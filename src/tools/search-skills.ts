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
    "Search the skill library. Use short keywords for known skills; mode=task for a full request. Results include confidence, match reasons, cache status, and size.",
    {
      query: z.string().trim().min(1).max(4000).describe("Short skill keywords for known-item lookup (e.g. 'PPT', '视频翻译'), or a full task when mode=task is appropriate"),
      category: z.string().optional().describe("Optional category filter, e.g. '05_多媒体与设计资产'"),
      limit: z.number().int().min(1).max(50).optional().default(8).describe("Max number of results to return (1–50, default: 8)"),
      mode: z.enum(["auto", "keyword", "task"]).optional().default("auto").describe("auto detects full task requests; keyword is for known-item lookup; task extracts deliverables and reranks candidates"),
      force_refresh: z.boolean().optional().describe("If true, forcefully refreshes the remote skills list cache. Use this when the user just integrated a new skill and it's not showing up."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ query, category, limit, mode, force_refresh }) =>
      withToolLogging("search_skills", { query, category, limit, mode, force_refresh }, async () => {
        // Throttled freshness poll (conditional GET): picks up newly integrated
        // remote skills within --manifest-poll seconds instead of the 24h TTL.
        if (force_refresh) {
          await searchEngine.refreshManifest();
        } else {
          // Serve the current index immediately; revalidate in the background.
          // Typos and empty result sets must never cause unthrottled downloads.
          void searchEngine.maybeRefreshManifest();
        }
        const page = searchEngine.searchWithTotal(query, { category, limit, mode });
        const results = page.results;

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
            const confidence = r.confidence_label
              ? ` confidence: ${r.confidence_label} (${r.confidence?.toFixed(2)})`
              : "";
            const size = r.size_bytes !== undefined
              ? ` · ${(r.size_bytes / (1024 * 1024)).toFixed(r.size_bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
              : "";
            const why = Array.isArray(r.match_reasons)
              ? r.match_reasons.slice(0, 3).join("、")
              : "";
            return `${i + 1}. **${r.name}**${badge} [${r.category}]${confidence}${size}\n   ${r.description.substring(0, 140)}${r.description.length > 140 ? "..." : ""}${why ? `\n   为什么: ${why}` : ""}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length}${page.total > results.length ? `/${page.total}` : ""} candidate skills (${results[0]?.match_mode ?? mode} mode):\n\n${formatted}\n\n${FOOTER_SEARCH}`,
            },
          ],
        };
      })
  );
}
