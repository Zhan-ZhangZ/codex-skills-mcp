import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { withToolLogging, logEvent } from "../lib/logger.js";

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
          const { content, size_bytes } = await loader.loadSkillFile(entry, file_path);

          return {
            content: [
              {
                type: "text" as const,
                text: `## ${skill_name} / ${file_path} (${size_bytes} bytes)\n\n${content}`,
              },
            ],
          };
        } catch (err) {
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
