import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { FOOTER_READ } from "../lib/protocol.js";
import { withToolLogging, logEvent } from "../lib/logger.js";

export function registerReadSkill(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "read_skill",
    "STEP 3 MATERIALIZE — MANDATORY before executing any skill, once for EVERY skill you plan to use. Downloads the COMPLETE skill directory (SKILL.md + scripts + configs + references) into the local cache (instant when already cached) and returns the instructions, file structure, dependencies, and local_path — the on-disk path to execute the skill from. After this call you MUST execute the task strictly per the returned instructions; do NOT do the task from general knowledge after reading.",
    {
      name: z.string().describe("Exact skill name from search/plan results, e.g. 'MediaCrawler'"),
    },
    async ({ name }, extra) =>
      withToolLogging("read_skill", { skill: name }, async () => {
        let entry = searchEngine.findByName(name);
        if (!entry) {
          // The local index may be stale (skill just integrated upstream).
          // Run the throttled freshness poll once and re-lookup before failing.
          if (typeof searchEngine.maybeRefreshManifest === "function") {
            await searchEngine.maybeRefreshManifest();
            entry = searchEngine.findByName(name);
          }
        }
        if (!entry) {
          logEvent("warn", "tool_error", { tool: "read_skill", skill: name, error: "skill not found" });
          return {
            content: [
              {
                type: "text" as const,
                text: `Skill "${name}" not found. The local skill index may be stale — call search_skills with force_refresh=true to reload the manifest, then retry read_skill("${name}").`,
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

          // Deep cache check right after materialization (read-only, fast)
          const cache = loader.cacheState(entry);

          // Format structure as a compact tree
          const structureStr = formatTree(result.structure.files, "");

          // Format sub-skills if any
          let subSkillsStr = "";
          if (result.structure.sub_skills.length > 0) {
            subSkillsStr =
              "\n## Sub-Skills\n" +
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

          // Cache & Execution section: makes "it is on disk, execute from here" visible
          const statusLine = cache.complete
            ? `✅ complete — ${cache.filesTotal} files (${formatBytes(cache.sizeBytes)})${cache.completedAt ? `, downloaded ${cache.completedAt}` : ""}`
            : cache.cached
              ? `⚠️ INCOMPLETE — ${cache.filesMissing.length} of ${cache.filesTotal} files missing. Re-call read_skill("${entry.name}") to resume the download.`
              : `⚠️ not cached — re-call read_skill("${entry.name}") to download.`;

          const cacheSection = [
            "## Cache & Execution",
            `
- Status: ${statusLine}`,
            `
- **local_path**: \`${cache.localPath}\``,
            result.dependencies.setup_command
              ? `\n- Setup before first run: \`${result.dependencies.setup_command}\``
              : "",
            "\n- The complete skill now lives on local disk. Run its scripts from local_path and follow the Instructions above exactly.",
          ]
            .filter(Boolean)
            .join("");

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
                  cacheSection,
                  subSkillsStr,
                  "",
                  "---",
                  FOOTER_READ,
                ].join("\n"),
              },
            ],
          };
        } catch (err) {
          // Record the failure so search ranking can demote unreliable skills
          if (typeof searchEngine.recordFailure === "function") {
            searchEngine.recordFailure(entry.name);
          }
          const message = err instanceof Error ? err.message : String(err);
          logEvent("error", "tool_error", { tool: "read_skill", skill: entry.name, error: message });
          return {
            content: [
              {
                type: "text" as const,
                text: `Error reading skill "${name}": ${message}\n\nIf this is a network failure, retry read_skill — the download resumes from where it stopped. Use diagnostics to inspect recent errors.`,
              },
            ],
          };
        }
      })
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0B";
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
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
