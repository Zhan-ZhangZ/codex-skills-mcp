import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";

export function registerLoadSkillFile(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "load_skill_file",
    "Read a specific file from within a skill's directory. Use this after read_skill when you need to access scripts, configs, README, or other resources referenced in the skill instructions.",
    {
      skill_name: z.string().describe("Skill name, e.g. 'MediaCrawler'"),
      file_path: z.string().describe("Relative path within the skill directory, e.g. 'README.md' or 'scripts/run.py'"),
    },
    async ({ skill_name, file_path }) => {
      const entry = searchEngine.findByName(skill_name);
      if (!entry) {
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
        const result = loader.loadSkillFile(entry, file_path);

        return {
          content: [
            {
              type: "text" as const,
              text: `## ${skill_name} / ${file_path} (${result.size_bytes} bytes)\n\n${result.content}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error loading file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
