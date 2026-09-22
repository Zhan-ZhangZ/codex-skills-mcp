import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { withToolLogging, logEvent } from "../lib/logger.js";

export function registerListSkillFiles(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "list_skill_files",
    "List the file tree of a skill or a subdirectory within it (structure only, no content). Use it to understand a large skill's layout before deciding which files to read. Verify the local cache is complete with skill_status before executing a skill.",
    {
      skill_name: z.string().describe("Skill name, e.g. 'KrillinAI'"),
      path: z.string().optional().default("").describe("Subdirectory path within the skill (default: root)"),
      max_depth: z.number().optional().default(2).describe("Directory scan depth (default: 2)"),
    },
    async ({ skill_name, path, max_depth }) =>
      withToolLogging("list_skill_files", { skill: skill_name, path, max_depth }, async () => {
        const entry = searchEngine.findByName(skill_name);
        if (!entry) {
          logEvent("warn", "tool_error", { tool: "list_skill_files", skill: skill_name, error: "skill not found" });
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
          const files = await loader.listSkillFiles(entry, path, max_depth);
          const treeStr = formatFileTree(files, "");

          return {
            content: [
              {
                type: "text" as const,
                text: `## ${skill_name}${path ? "/" + path : ""} file tree\n\n\`\`\`\n${treeStr}\n\`\`\`\n\nUse load_skill_file(skill_name, file_path) to read any file; use skill_status to verify cache completeness before executing.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logEvent("warn", "tool_error", { tool: "list_skill_files", skill: skill_name, error: message });
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${message}`,
              },
            ],
          };
        }
      })
  );
}

function formatFileTree(
  nodes: { name: string; type: string; size_bytes?: number; children?: any[] }[],
  indent: string
): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.type === "directory") {
      lines.push(`${indent}📁 ${node.name}/`);
      if (node.children) {
        lines.push(formatFileTree(node.children, indent + "  "));
      }
    } else {
      const size = node.size_bytes
        ? ` (${node.size_bytes > 1024 ? Math.round(node.size_bytes / 1024) + "KB" : node.size_bytes + "B"})`
        : "";
      lines.push(`${indent}📄 ${node.name}${size}`);
    }
  }
  return lines.join("\n");
}
