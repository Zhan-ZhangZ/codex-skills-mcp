import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import { withToolLogging, logEvent } from "../lib/logger.js";
import { raceDownloadDeadline, DownloadDeadlineExceeded } from "../lib/deadline.js";
import { fileNavigationRows, subSkillNavigationRows, navigationPath, navigationPage, navigationFooter, navigationMetadata, DEFAULT_NAVIGATION_LIMIT, MAX_NAVIGATION_LIMIT } from "../lib/navigation.js";

export function registerListSkillFiles(
  server: McpServer,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): void {
  server.tool(
    "list_skill_files",
    "Browse a skill without repeating its root instructions. view=files lists a directory tree; view=sub_skills searches ALL nested sub-skill names, paths and descriptions. query filters the entire list before pagination. Large lists use bounded pages with an opaque next cursor; pass the same view/path/query/max_depth with cursor. Source or content changes invalidate cursors: restart without cursor. Use load_skill_file for complete file instructions, and skill_status before execution.",
    {
      skill_name: z.string().describe("Skill name, e.g. 'KrillinAI'"),
      path: z.string().max(4096).optional().default("").describe("Subdirectory path within the skill (default: root)"),
      max_depth: z.number().int().min(0).max(8).optional().default(2).describe("File tree depth (0–8, default: 2); sub_skills always searches all nested depths"),
      view: z.enum(["files", "sub_skills"]).optional().default("files").describe("Directory entries or nested skill summaries"),
      query: z.string().max(500).optional().default("").describe("Case-insensitive words matched against all names/paths and sub-skill descriptions before paging"),
      limit: z.number().int().min(1).max(MAX_NAVIGATION_LIMIT).optional().default(DEFAULT_NAVIGATION_LIMIT).describe("Maximum entries per page (1–100); a byte budget may return fewer"),
      cursor: z.string().min(1).max(512).optional().describe("Opaque next_cursor from the previous page; omit to start or change filters"),
    },
    { readOnlyHint: true },
    async ({ skill_name, path = "", max_depth = 2, view = "files", query = "", limit = DEFAULT_NAVIGATION_LIMIT, cursor }) =>
      withToolLogging("list_skill_files", { skill: skill_name, path, max_depth, view }, async () => {
        const entry = searchEngine.findByName(skill_name);
        if (!entry) {
          logEvent("warn", "tool_error", { tool: "list_skill_files", skill: skill_name, error: "skill not found" });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Skill "${skill_name}" not found.`,
              },
            ],
          };
        }

        try {
          const normalizedPath = navigationPath(path);
          const { softDeadlineMs, hardDeadlineMs } = loader.downloadDeadlines;
          const deadlineMs = Math.min(softDeadlineMs || Infinity, hardDeadlineMs || Infinity);
          const snapshot = await raceDownloadDeadline(
            loader.readNavigation(entry, { view, path: normalizedPath, maxDepth: max_depth }),
            deadlineMs === Infinity ? 0 : deadlineMs, "soft",
          );
          const rows = view === "files" ? fileNavigationRows(snapshot.files, normalizedPath) : subSkillNavigationRows(snapshot.sub_skills);
          const context = { identity: snapshot.identity, skillName: entry.name, view, path: normalizedPath, query, maxDepth: max_depth };
          const page = navigationPage(rows, context, { limit, cursor });
          const body = view === "files" && !cursor && !query && !page.nextCursor
            ? formatFileTree(snapshot.files, "") : page.rows.map(item => item.text).join("\n");
          const revisionNote = snapshot.cache.cached && snapshot.cache.catalogCurrent === false
            ? "\nCached revision: the current manifest catalog has not been validated. Retry when the source is available.\n" : "";
          const nextFile = page.rows.find(item => item.row.type !== "directory")?.row;
          const filePath = nextFile ? nextFile.path + (nextFile.type === "sub_skill" ? "/SKILL.md" : "") : "RELATIVE_FILE_PATH";
          const support = `Read complete content: load_skill_file(${JSON.stringify({ skill_name: entry.name, file_path: filePath })}). Use skill_status before execution.`;

          return {
            structuredContent: { skill_name: entry.name, view, path: normalizedPath, query, ...navigationMetadata(page) },
            content: [
              {
                type: "text" as const,
                text: [`## ${entry.name}${normalizedPath ? "/" + normalizedPath : ""} ${view === "files" ? "file tree" : "sub-skills"}`,
                  revisionNote, view === "files" ? "```\n" + body + "\n```" : body,
                  navigationFooter(context, page), support].filter(Boolean).join("\n\n"),
              },
            ],
          };
        } catch (err) {
          if (err instanceof DownloadDeadlineExceeded) return { content: [{ type: "text" as const,
            text: `The skill is still materializing in the background. Retry list_skill_files(${JSON.stringify({ skill_name, path, max_depth, view, query, limit, ...(cursor ? { cursor } : {}) })}) to continue.` }] };
          const message = err instanceof Error ? err.message : String(err);
          logEvent("warn", "tool_error", { tool: "list_skill_files", skill: skill_name, error: message });
          return {
            isError: true,
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
