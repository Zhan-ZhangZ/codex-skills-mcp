import { z } from "zod";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillSearchEngine } from "../search/index.js";
import type { SkillLoader } from "../loader/index.js";
import type { Config } from "../config.js";
import { FOOTER_DIAGNOSTICS } from "../lib/protocol.js";
import { withToolLogging, readRecentEvents, loggerActive, logDirPath } from "../lib/logger.js";
import { readManifestMeta } from "../remote/github.js";

const TREE_MARKER = ".codex-skills.tree.json";
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "logs"]);

interface CacheStats {
  skillsWithMarker: number;
  complete: number;
  incomplete: number;
  totalBytes: number;
}

/** Walk the cache dir (bounded depth) collecting tree markers. */
function collectCacheStats(dir: string, depth: number, stats: CacheStats): void {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== TREE_MARKER) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectCacheStats(full, depth + 1, stats);
    } else if (e.isFile() && e.name === TREE_MARKER) {
      stats.skillsWithMarker += 1;
      try {
        const marker = JSON.parse(readFileSync(full, "utf-8")) as {
          completedAt?: string;
          files?: { size?: number }[];
        };
        if (marker.completedAt && Array.isArray(marker.files)) {
          stats.complete += 1;
          stats.totalBytes += marker.files.reduce((s, f) => s + (f.size || 0), 0);
        } else {
          stats.incomplete += 1;
        }
      } catch {
        stats.incomplete += 1;
      }
    }
  }
}

export function registerDiagnostics(
  server: McpServer,
  config: Config,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader,
  version: string
): void {
  server.tool(
    "diagnostics",
    "Audit and troubleshoot the skill library: recent tool calls and recent errors from the activity log, cache statistics (cached skill count / total size), manifest freshness and config summary. Use it when a call fails, when a download looks wrong, or to verify what the agent actually did (which tools ran, which skills downloaded).",
    {
      include_log: z.boolean().optional().default(true).describe("Include recent activity-log entries (default: true)"),
      log_lines: z.number().optional().default(20).describe("Max log entries per section (default: 20)"),
    },
    async ({ include_log, log_lines }) =>
      withToolLogging("diagnostics", { include_log, log_lines }, async () => {
        const sections: string[] = [];

        // Server / config summary
        const totalSkills = searchEngine
          .getCategories()
          .reduce((s, c) => s + c.skill_count, 0);
        let manifestAge = "unknown";
        try {
          const ageMs = Date.now() - statSync(config.manifestPath).mtimeMs;
          manifestAge =
            ageMs < 3600000
              ? `${Math.round(ageMs / 60000)} min`
              : `${Math.round(ageMs / 3600000)} h`;
        } catch {
          // ignore
        }
        sections.push(
          "## Server",
          [
            `- Version: ${version}`,
            `- Mode: ${config.isRemote ? "remote (on-demand download)" : "local (skills-dir)"}`,
            `- Remote: ${config.githubRepo ?? "-"}@${config.githubBranch ?? "-"}`,
            `- Cache dir: \`${config.skillsDir}\``,
          ].join("\n")
        );

        const meta = readManifestMeta(config);
        const validated = meta.validatedAt
          ? new Date(meta.validatedAt).toISOString()
          : "never";
        sections.push(
          "## Manifest",
          [
            `- Skills indexed: ${totalSkills}`,
            `- Manifest age: ${manifestAge} (TTL ${Math.round(config.manifestTTL / 3600000)}h)`,
            `- Last freshness check: ${validated} (poll every ${Math.round(config.manifestPollMs / 1000)}s)`,
            `- ETag: ${meta.etag ? meta.etag.slice(0, 24) + "…" : "(none — next poll fetches full)"}`,
          ].join("\n")
        );

        // Cache stats
        if (config.isRemote) {
          const stats: CacheStats = { skillsWithMarker: 0, complete: 0, incomplete: 0, totalBytes: 0 };
          collectCacheStats(config.skillsDir, 0, stats);
          sections.push(
            "## Local skill cache",
            [
              `- Skills materialized: ${stats.complete} complete, ${stats.incomplete} incomplete`,
              `- Total cached size: ${(stats.totalBytes / (1024 * 1024)).toFixed(1)}MB`,
            ].join("\n")
          );
        } else {
          sections.push("## Local skill cache", "- Local mode: skills-dir is the cache itself.");
        }

        // Activity log
        if (!loggerActive()) {
          sections.push(
            "## Activity log",
            "- File logging disabled (local mode). Events were only mirrored to stderr."
          );
        } else if (!include_log) {
          sections.push("## Activity log", `- Location: \`${logDirPath()}\` (include_log=false, entries skipped)`);
        } else {
          const errors = readRecentEvents({ limit: log_lines, level: "error" });
          const calls = readRecentEvents({ limit: log_lines, event: "tool_call" });
          const downloads = readRecentEvents({ limit: log_lines, event: "download_skill_complete" });

          const fmt = (e: ReturnType<typeof readRecentEvents>[number]) =>
            `${e.ts} [${e.event}] ${e.tool ?? ""}${e.skill ? " " + e.skill : ""}${e.ok === false ? " FAILED" : ""}${e.error ? " — " + e.error : ""}${e.detail ? " (" + e.detail + ")" : ""}`.replace(/\s+/g, " ");

          sections.push(
            "## Recent errors",
            errors.length > 0 ? errors.map(fmt).map((l) => "- " + l).join("\n") : "- None 🎉"
          );
          sections.push(
            "## Recent downloads",
            downloads.length > 0 ? downloads.map(fmt).map((l) => "- " + l).join("\n") : "- None in retained logs"
          );
          sections.push(
            "## Recent tool calls",
            calls.length > 0 ? calls.map(fmt).map((l) => "- " + l).join("\n") : "- None in retained logs"
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: ["# codex-skills-mcp diagnostics", "", sections.join("\n\n"), "", "---", FOOTER_DIAGNOSTICS].join("\n"),
            },
          ],
        };
      })
  );
}
