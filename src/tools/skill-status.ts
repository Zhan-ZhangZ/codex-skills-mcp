import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { FOOTER_STATUS } from "../lib/protocol.js";
import { withToolLogging } from "../lib/logger.js";

const MAX_NAMES = 20;

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0B";
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export function registerSkillStatus(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "skill_status",
    "Check cache completeness and size for one or more skills. Read-only; never downloads.",
    {
      names: z.string().describe("Comma-separated exact skill names, e.g. 'KrillinAI, videocut-skills' (max 20)"),
    },
    { readOnlyHint: true },
    async ({ names }) =>
      withToolLogging("skill_status", { names }, async () => {
        const requested = names
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        const unique = Array.from(new Set(requested)).slice(0, MAX_NAMES);
        const truncated = Array.from(new Set(requested)).length > MAX_NAMES;

        if (unique.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No skill names provided. Pass names like 'KrillinAI, videocut-skills'.",
              },
            ],
          };
        }

        const lines: string[] = [];
        let completeCount = 0;
        const skills: Array<Record<string, unknown>> = [];
        const butler = typeof searchEngine.getButlerEntry === "function"
          ? searchEngine.getButlerEntry()
          : undefined;

        for (const name of unique) {
          const entry = searchEngine.findByName(name)
            ?? (butler?.name.toLowerCase() === name.toLowerCase() ? butler : undefined);
          if (!entry) {
            lines.push(`### ❌ ${name}\n- Not found in the library. Use search_skills to find the exact name.`);
            skills.push({ name, found: false });
            continue;
          }
          if (butler && entry.name === butler.name) {
            completeCount += 1;
            skills.push({
              name: entry.name,
              found: true,
              cached: true,
              complete: true,
              root: true,
              cacheable: false,
              catalog_current: true,
              local_path: "",
              files_total: 1,
              files_missing_count: 0,
              files_missing_preview: [],
              size_bytes: 0,
              completed_at: null,
            });
            lines.push(
              `### 🌐 ${entry.name}\n` +
              "- Status: ✅ global router — source-root SKILL.md is read directly; no separate cache directory"
            );
            continue;
          }
          const cache = loader.cacheState(entry);
          if (cache.complete) completeCount += 1;
          skills.push({
            name: entry.name,
            found: true,
            cached: cache.cached,
            complete: cache.complete,
            catalog_current: cache.catalogCurrent ?? null,
            local_path: cache.localPath,
            files_total: cache.filesTotal,
            files_missing_count: cache.filesMissing.length,
            files_missing_preview: cache.filesMissing.slice(0, 20),
            size_bytes: cache.sizeBytes,
            completed_at: cache.completedAt ?? null,
          });

          const status = cache.complete
            ? `✅ complete — ${cache.filesTotal} files (${formatBytes(cache.sizeBytes)})`
            : cache.cached && cache.catalogCurrent === false
              ? `⚠️ cached revision — current manifest catalog not validated. Retry read_skill("${entry.name}") when the source is available.`
              : cache.cached
                ? `⚠️ INCOMPLETE — missing ${cache.filesMissing.length}/${cache.filesTotal} files: ${cache.filesMissing.slice(0, 5).join(", ")}${cache.filesMissing.length > 5 ? ", …" : ""}`
                : "⬜ not downloaded yet — call read_skill to materialize it";

          lines.push(
            [
              `### ${cache.complete ? "✅" : cache.cached ? "⚠️" : "⬜"} ${entry.name}`,
              `- Status: ${status}`,
              `- local_path: \`${cache.localPath}\``,
              cache.completedAt ? `- Downloaded at: ${cache.completedAt}` : "",
            ]
              .filter(Boolean)
              .join("\n")
          );
        }

        const header = `Skill cache status: ${completeCount}/${unique.length} complete${truncated ? ` (list truncated to ${MAX_NAMES})` : ""}`;
        return {
          structuredContent: {
            requested: unique.length,
            complete_count: completeCount,
            truncated,
            skills,
          },
          content: [
            {
              type: "text" as const,
              text: [header, "", lines.join("\n\n"), "", FOOTER_STATUS].join("\n"),
            },
          ],
        };
      })
  );
}
