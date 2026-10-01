/**
 * OpenAI MCP Extensions — Structured Settings
 *
 * Implements the `openai/settings` extension from
 * https://github.com/openai/mcp-extensions (spec §Structured Settings) using
 * the official `@openai/mcp-extensions` SDK helper.
 *
 * What it adds:
 *   - `settings.read` / `settings.update` tools on the server.
 *   - `capabilities.extensions["openai/settings"]` (+ legacy `experimental`)
 *     advertised in the initialize result, so ChatGPT renders a native
 *     settings panel on the plugin details page.
 *   - Hosts that do not understand the extension ignore the capability and
 *     the two extra tools keep working as ordinary MCP tools.
 *
 * Values are persisted to ~/.codex-skills-mcp/settings.json (never inside a
 * skill library — same policy as the activity log) and applied to the shared
 * Config object, which every subsystem reads at call time, so updates take
 * effect without a restart and survive restarts.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";

import type { Config } from "../config.js";
import type { SkillSearchEngine } from "../search/index.js";
import { logEvent } from "../lib/logger.js";

/** Effective (persisted-override) settings shape exposed to the host UI. */
export interface EffectiveSettings {
  cn_mirror: boolean;
  download_concurrency: number;
  download_timeout_seconds: number;
  manifest_ttl_hours: number;
  manifest_poll_seconds: number;
}

/** File shape — a partial subset of EffectiveSettings. */
type PersistedSettings = Partial<EffectiveSettings>;

const SETTINGS_DIR = resolve(homedir(), ".codex-skills-mcp");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

/** Zod schemas per field — single source for validation and type inference. */
const SCHEMAS = {
  cn_mirror: z.boolean(),
  download_concurrency: z.number().int().min(1).max(64),
  download_timeout_seconds: z.number().int().min(5).max(300),
  manifest_ttl_hours: z.number().int().min(0).max(168),
  manifest_poll_seconds: z.number().int().min(0).max(3600),
};

const VALUES_SCHEMA = z.object(SCHEMAS).strict();

/** Field definitions shared by read/update validation (single source). */
const FIELDS: Record<keyof EffectiveSettings, { schema: (typeof SCHEMAS)[keyof EffectiveSettings]; title: string; description?: string }> = {
  cn_mirror: {
    schema: SCHEMAS.cn_mirror,
    title: "Use CN mirror (ghproxy)",
    description:
      "Route remote skill downloads through the China mirror. Only affects remote mode fetching.",
  },
  download_concurrency: {
    schema: SCHEMAS.download_concurrency,
    title: "Download concurrency",
    description: "Parallel downloads when materializing a skill (1–64).",
  },
  download_timeout_seconds: {
    schema: SCHEMAS.download_timeout_seconds,
    title: "Download timeout (seconds)",
    description: "Per-request timeout for skill file downloads (5–300s).",
  },
  manifest_ttl_hours: {
    schema: SCHEMAS.manifest_ttl_hours,
    title: "Manifest cache TTL (hours)",
    description: "How long the skills manifest stays fresh (0 = never auto-refresh, max 168).",
  },
  manifest_poll_seconds: {
    schema: SCHEMAS.manifest_poll_seconds,
    title: "Freshness poll interval (seconds)",
    description:
      "Throttled conditional-GET poll on search/plan calls to pick up newly integrated skills (0 = disabled).",
  },
};

function loadPersisted(): PersistedSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as PersistedSettings;
  } catch (err) {
    console.error(`[codex-skills-mcp] Could not read settings file, using defaults: ${err}`);
    return {};
  }
}

function persist(partial: PersistedSettings): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(partial, null, 2) + "\n", "utf-8");
  renameSync(tmp, SETTINGS_PATH); // atomic on POSIX
}

/** Config-derived defaults for every field. */
function defaultsFromConfig(config: Config): EffectiveSettings {
  return {
    cn_mirror: config.useCnMirror,
    download_concurrency: config.downloadConcurrency,
    download_timeout_seconds: Math.round(config.downloadTimeout / 1000),
    manifest_ttl_hours: Math.round(config.manifestTTL / 3_600_000),
    manifest_poll_seconds: Math.round(config.manifestPollMs / 1000),
  };
}

/** Push effective settings back onto the live Config (read at call time). */
function applyToConfig(config: Config, s: EffectiveSettings): void {
  config.useCnMirror = s.cn_mirror;
  config.downloadConcurrency = s.download_concurrency;
  config.downloadTimeout = s.download_timeout_seconds * 1000;
  config.manifestTTL = Math.round(s.manifest_ttl_hours * 3_600_000);
  config.manifestPollMs = s.manifest_poll_seconds * 1000;
}

/** Merge persisted overrides over config defaults. */
function effective(config: Config, persisted: PersistedSettings): EffectiveSettings {
  const base = defaultsFromConfig(config);
  const merged: EffectiveSettings = { ...base };
  for (const key of Object.keys(FIELDS) as (keyof EffectiveSettings)[]) {
    const v = persisted[key];
    const parse = FIELDS[key].schema.safeParse(v);
    if (parse.success) {
      (merged as unknown as Record<string, unknown>)[key] = parse.data;
    } else if (v !== undefined) {
      console.error(
        `[codex-skills-mcp] Ignoring invalid persisted setting "${key}": ${JSON.stringify(v)}`
      );
    }
  }
  return merged;
}

/**
 * Overlay persisted settings onto a freshly parsed Config. Call once at
 * startup (before remote init / manifest fetch) so restarts honor them.
 */
export function applyPersistedSettingsAtStartup(config: Config): void {
  applyToConfig(config, effective(config, loadPersisted()));
}

/**
 * Register the settings extension plus the "refresh skills list" tool action
 * on the given OpenAIExtensions facade.
 */
export function registerOpenAISettings(
  server: McpServer,
  extensions: OpenAIExtensions,
  config: Config,
  searchEngine: SkillSearchEngine
): void {
  let current = effective(config, loadPersisted());

  extensions.settings.register({
    readTool: "settings.read",
    updateTool: "settings.update",
    fields: FIELDS,
    layout: [
      {
        kind: "group",
        title: "Downloads & cache",
        items: [
          { kind: "property", property: "cn_mirror" },
          { kind: "property", property: "download_concurrency" },
          { kind: "property", property: "download_timeout_seconds" },
          { kind: "property", property: "manifest_ttl_hours" },
          { kind: "property", property: "manifest_poll_seconds" },
        ],
      },
      {
        kind: "group",
        title: "Maintenance",
        items: [
          {
            kind: "tool",
            tool: "refresh_skills_list",
            title: "Refresh skills list",
            description: "Re-download the skills manifest from the remote source now.",
          },
        ],
      },
    ],
    read: () => current,
    update: (set) => {
      const next = { ...current, ...set };
      // Full validation (cross-field rules would also live here).
      const parsed: EffectiveSettings = VALUES_SCHEMA.parse(next);
      persist(parsed);
      applyToConfig(config, parsed);
      current = parsed;
      logEvent("info", "settings_updated", { detail: JSON.stringify(set) });
      console.error(`[codex-skills-mcp] Settings updated: ${JSON.stringify(set)}`);
      return current;
    },
  });

  // Tool action rendered as a button in the ChatGPT settings panel. Regular
  // tool semantics per spec: accepts {}, ChatGPT shows the text response in
  // a tooltip after a spinner.
  server.tool(
    "refresh_skills_list",
    "Re-downloads the skills manifest from the remote source, picking up newly integrated " +
      "skills immediately. Read-only for local skill libraries (their manifest lives on disk).",
    async () => {
      if (typeof searchEngine.refreshManifest !== "function") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Local mode: the manifest is read from disk. Re-run with an updated skills_manifest.json instead.",
            },
          ],
        };
      }
      const ok = await searchEngine.refreshManifest();
      const categories = searchEngine.getCategories();
      const total = categories.reduce((s, c) => s + c.skill_count, 0);
      return {
        content: [
          {
            type: "text" as const,
            text: ok
              ? `Skills manifest refreshed: ${total} skills across ${categories.length} categories.`
              : `Manifest refresh skipped or failed (cache still fresh or network issue). Current index: ${total} skills.`,
          },
        ],
      };
    }
  );
}
