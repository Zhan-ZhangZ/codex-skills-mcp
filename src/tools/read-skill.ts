import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";

export function registerReadSkill(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "read_skill",
    "Read a skill's full instructions (SKILL.md), file structure, and dependency info. Call this after search_skills to load a skill you want to use. The instructions contain the role and execution rules you should follow.",
    {
      name: z.string().describe("Exact skill name from search results, e.g. 'MediaCrawler'"),
    },
    async ({ name }, extra) => {
      const entry = searchEngine.findByName(name);
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Skill "${name}" not found. Use search_skills to find available skills.`,
            },
          ],
        };
      }

      // MCP progress notifications — clients opt in by sending a progressToken
      // in the request meta. Without one we stay silent (backwards compatible).
      const progressToken = extra?._meta?.progressToken;
      const sendProgress = (progress: number, total: number, message: string) => {
        if (progressToken !== undefined) {
          void extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, total, message },
          });
        }
      };

      try {
        const result = await loader.readSkill(entry, (done, total, message) =>
          sendProgress(done, total, message)
        );

        // Record usage for personalized search ranking
        if (typeof searchEngine.recordUsage === "function") {
          searchEngine.recordUsage(entry.name);
        }

        // Format structure as a compact tree
        const structureStr = formatTree(result.structure.files, "");

        // Format sub-skills if any
        let subSkillsStr = "";
        if (result.structure.sub_skills.length > 0) {
          subSkillsStr =
            "\n\n## Sub-Skills\n" +
            result.structure.sub_skills
              .map((s) => `- **${s.name}** (${s.path}): ${s.description}`)
              .join("\n");
          subSkillsStr +=
            "\n\nUse read_skill or load_skill_file to access sub-skill instructions.";
        }

        // Format dependencies
        const depsStr = [
          `Language: ${result.dependencies.language}`,
          result.dependencies.package_manager
            ? `Package Manager: ${result.dependencies.package_manager}`
            : null,
          result.dependencies.setup_command
            ? `Setup: \`${result.dependencies.setup_command}\``
            : null,
        ]
          .filter(Boolean)
          .join(" | ");

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `# Skill: ${entry.name}`,
                `**Category**: ${entry.category}`,
                `**Dependencies**: ${depsStr}`,
                "",
                "## Instructions",
                "",
                result.instructions,
                "",
                "## File Structure",
                "```",
                structureStr,
                "```",
                subSkillsStr,
                "",
                "---",
                "Use load_skill_file(skill_name, file_path) to read any file shown above.",
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        // Record the failure so search ranking can demote unreliable skills
        if (typeof searchEngine.recordFailure === "function") {
          searchEngine.recordFailure(entry.name);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}

function formatTree(nodes: { name: string; type: string; size_bytes?: number; children?: any[] }[], indent: string): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.type === "directory") {
      lines.push(`${indent}📁 ${node.name}/`);
      if (node.children) {
        lines.push(formatTree(node.children, indent + "  "));
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
