import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { FOOTER_READ } from "../lib/protocol.js";
import { withToolLogging, logEvent } from "../lib/logger.js";
import { raceDownloadDeadline, DownloadDeadlineExceeded } from "../lib/deadline.js";
import { fileNavigationRows, subSkillNavigationRows, navigationPage, navigationFooter, navigationMetadata } from "../lib/navigation.js";

export function registerReadSkill(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "read_skill",
    "STEP 3 MATERIALIZE — MANDATORY before executing any skill, once for EVERY skill you plan to use. Downloads the COMPLETE skill directory (SKILL.md + scripts + configs + references) into the local cache and returns the FULL root instructions, dependencies, local_path, and a bounded directory/sub-skill preview. Large navigation lists include list_skill_files pagination and search calls; only navigation labels may be excerpts. After this call you MUST execute the task strictly per the returned instructions; do NOT do the task from general knowledge after reading.",
    {
      name: z.string().describe("Exact skill name from search/plan results, e.g. 'MediaCrawler'"),
    },
    { readOnlyHint: true },
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
            isError: true,
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
        let progressOpen = true;
        const sendProgress = (progress: number, total: number, message: string) => {
          if (progressOpen && progressToken !== undefined && !extra.signal.aborted) {
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, total, message },
            }).catch(() => {});
          }
        };

        try {
          // Deadline strategy: clients WITH a progressToken keep receiving
          // progress notifications that reset their timeout, so they only
          // need the hard guard. Clients WITHOUT one typically enforce a
          // 60s request timeout and would kill the call silently — give
          // them the soft deadline (default 55s) so the model always gets
          // a structured response telling it to re-call and resume.
          const hasProgressToken = progressToken !== undefined;
          const { softDeadlineMs, hardDeadlineMs } = loader.downloadDeadlines;
          const deadlineMs = hasProgressToken
            ? hardDeadlineMs
            : Math.min(softDeadlineMs || Infinity, hardDeadlineMs || Infinity);
          const deadlineKind: "soft" | "hard" = hasProgressToken ? "hard" : "soft";

          const result = await raceDownloadDeadline(
            loader.readSkill(entry, (done, total, message) =>
              sendProgress(done, total, message)
            ),
            deadlineMs === Infinity ? 0 : deadlineMs,
            deadlineKind
          );

          // Record usage for personalized search ranking
          if (typeof searchEngine.recordUsage === "function") {
            searchEngine.recordUsage(entry.name);
          }

          // Reuse the request-bound state checked by the loader. Older custom
          // loaders can still supply only the original instructions result.
          const cache = result.cache ?? loader.cacheState(entry);

          const identity = result.navigationIdentity ?? JSON.stringify([entry.name, entry.relative_path, entry.file_index?.sha256]);
          const filesContext = { identity, skillName: entry.name, view: "files" as const, maxDepth: 2 };
          const subSkillsContext = { identity, skillName: entry.name, view: "sub_skills" as const };
          const filesPage = navigationPage(fileNavigationRows(result.structure.files), filesContext);
          const subSkillsPage = navigationPage(subSkillNavigationRows(result.structure.sub_skills), subSkillsContext);
          const structureStr = filesPage.nextCursor
            ? filesPage.rows.map(item => item.text).join("\n")
            : formatTree(result.structure.files, "");
          const structureNavigation = filesPage.nextCursor ? navigationFooter(filesContext, filesPage) : "";

          // Format sub-skills if any
          let subSkillsStr = "";
          if (result.structure.sub_skills.length > 0) {
            subSkillsStr =
              "\n## Sub-Skills\n" +
              subSkillsPage.rows.map(item => item.text).join("\n");
            if (subSkillsPage.nextCursor || subSkillsPage.excerpted) subSkillsStr += "\n\n" + navigationFooter(subSkillsContext, subSkillsPage);
            const first = subSkillsPage.rows[0]?.row.path;
            subSkillsStr += "\n\nRead complete sub-skill instructions with load_skill_file(" +
              JSON.stringify({ skill_name: entry.name, file_path: `${first ?? "SUB_SKILL_PATH"}/SKILL.md` }) + ").";
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
          const cachedRevision = cache.cached && cache.catalogCurrent === false;
          const statusLine = cache.complete
            ? `✅ complete — ${cache.filesTotal} files (${formatBytes(cache.sizeBytes)})${cache.completedAt ? `, downloaded ${cache.completedAt}` : ""}`
            : cachedRevision
              ? `⚠️ cached revision — current manifest catalog not validated. Retry read_skill("${entry.name}") when the source is available.`
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
            cachedRevision
              ? "\n- local_path contains a cached revision. The instructions above describe that cached revision; completeness against the current manifest has not been verified."
              : cache.complete
                ? "\n- The complete skill now lives on local disk. Run its scripts from local_path and follow the Instructions above exactly."
                : "\n- Materialization is not complete. Re-call read_skill to finish downloading, then use skill_status to verify completeness before execution.",
          ]
            .filter(Boolean)
            .join("");

          return {
            structuredContent: { navigation: { files: navigationMetadata(filesPage), sub_skills: navigationMetadata(subSkillsPage) } },
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
                  structureNavigation,
                  cacheSection,
                  subSkillsStr,
                  "",
                  "---",
                  cachedRevision
                    ? `▶ Retry read_skill("${entry.name}") when the source is available, then use skill_status to verify the current manifest revision before execution.`
                    : cache.complete
                      ? FOOTER_READ
                      : `▶ Re-call read_skill("${entry.name}") to complete materialization, then use skill_status to verify completeness before execution.`,
                ].join("\n"),
              },
            ],
          };
        } catch (err) {
          if (err instanceof DownloadDeadlineExceeded) {
            // Deadline hit — the download CONTINUES in the background and
            // keeps writing into the cache. Report precise progress and an
            // explicit resume instruction so the model never sits blind.
            const cache = loader.cacheState(entry);
            const total = cache.filesTotal || 0;
            const have = total - (cache.filesMissing?.length ?? total);
            logEvent("info", "download_deadline", {
              tool: "read_skill",
              skill: entry.name,
              detail: `${err.kind} deadline, ${have}/${total} files`,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `⏳ Skill "${entry.name}" is still downloading: ${have}/${total} files on disk (${Math.round((have / Math.max(total, 1)) * 100)}%).\n\n` +
                    `The download continues in the background and resumes automatically — nothing is lost.\n\n` +
                    `**NEXT STEP: re-call read_skill("${entry.name}") now.** It returns instantly once the remaining files land; for very large skills you may need to re-call a few times (each call tops up the cache).`,
                },
              ],
            };
          }
          // Record the failure so search ranking can demote unreliable skills
          if (typeof searchEngine.recordFailure === "function") {
            searchEngine.recordFailure(entry.name);
          }
          const message = err instanceof Error ? err.message : String(err);
          logEvent("error", "tool_error", { tool: "read_skill", skill: entry.name, error: message });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Error reading skill "${name}": ${message}\n\nIf this is a network failure, retry read_skill — the download resumes from where it stopped. Use diagnostics to inspect recent errors.`,
              },
            ],
          };
        } finally {
          progressOpen = false;
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
