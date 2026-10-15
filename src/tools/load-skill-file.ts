import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { withToolLogging, logEvent } from "../lib/logger.js";
import { raceDownloadDeadline, DownloadDeadlineExceeded } from "../lib/deadline.js";

export function registerLoadSkillFile(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "load_skill_file",
    "STEP 4 support. Read a specific file from an ALREADY materialized skill's directory (call read_skill first). Use it for scripts, configs, README or other resources referenced by the skill instructions. Reading files through this tool NEVER replaces executing the skill per its SKILL.md from its local_path.",
    {
      skill_name: z.string().describe("Skill name, e.g. 'MediaCrawler'"),
      file_path: z.string().describe("Relative path within the skill directory, e.g. 'README.md' or 'scripts/run.py'"),
    },
    { readOnlyHint: true },
    async ({ skill_name, file_path }) =>
      withToolLogging("load_skill_file", { skill: skill_name, file: file_path }, async () => {
        const entry = searchEngine.findByName(skill_name);
        if (!entry) {
          logEvent("warn", "tool_error", { tool: "load_skill_file", skill: skill_name, error: "skill not found" });
          return {
            content: [
              {
                type: "text" as const,
                text: `Skill "${skill_name}" not found.`,
              },
            ],
          };
        }

        try {
          // Soft deadline only (this tool sends no progress notifications):
          // never let a background materialization hang the call past the
          // client's typical 60s timeout — the model always gets an answer.
          const { softDeadlineMs, hardDeadlineMs } = loader.downloadDeadlines;
          const deadlineMs = Math.min(softDeadlineMs || Infinity, hardDeadlineMs || Infinity);

          const { content, size_bytes } = await raceDownloadDeadline(
            loader.loadSkillFile(entry, file_path),
            deadlineMs === Infinity ? 0 : deadlineMs,
            "soft"
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `## ${skill_name} / ${file_path} (${size_bytes} bytes)\n\n${content}`,
              },
            ],
          };
        } catch (err) {
          if (err instanceof DownloadDeadlineExceeded) {
            const cache = loader.cacheState(entry);
            const total = cache.filesTotal || 0;
            const have = total - (cache.filesMissing?.length ?? total);
            logEvent("info", "download_deadline", {
              tool: "load_skill_file",
              skill: skill_name,
              detail: `${err.kind} deadline, ${have}/${total} files`,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `⏳ "${skill_name}" is still materializing (${have}/${total} files on disk) — the download continues in the background.\n\n` +
                    `**NEXT STEP: re-call load_skill_file("${skill_name}", "${file_path}")** in a moment; it returns the file as soon as the skill cache is complete.`,
                },
              ],
            };
          }
          const message = err instanceof Error ? err.message : String(err);
          logEvent("warn", "tool_error", { tool: "load_skill_file", skill: skill_name, error: message });
          return {
            content: [
              {
                type: "text" as const,
                text: `Error loading file: ${message}`,
              },
            ],
          };
        }
      })
  );
}
