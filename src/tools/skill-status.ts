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
    "STEP 5 VERIFY. Check the local cache state of one or more skills (deep check: every recorded file is present with the expected size; read-only, never downloads). Returns cached/complete flags, local_path, file counts, size, missing files and completion time per skill. Use it before executing to confirm materialization, or to diagnose incomplete/interrupted downloads.",
    {
      names: z.string().describe("Comma-separated exact skill names, e.g. 'KrillinAI, videocut-skills' (max 20)"),
    },
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

        for (const name of unique) {
          const entry = searchEngine.findByName(name);
          if (!entry) {
            lines.push(`### ❌ ${name}\n- Not found in the library. Use search_skills to find the exact name.`);
            continue;
          }
          const cache = loader.cacheState(entry);
          if (cache.complete) completeCount += 1;

          const status = cache.complete
            ? `✅ complete — ${cache.filesTotal} files (${formatBytes(cache.sizeBytes)})`
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
