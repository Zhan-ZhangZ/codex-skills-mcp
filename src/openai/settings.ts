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

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";

import type { Config } from "../config.js";
import type { SkillSearchEngine } from "../search/index.js";
import { logEvent } from "../lib/logger.js";
import type { UsageTelemetry } from "../lib/usage-telemetry.js";

/** Effective (persisted-override) settings shape exposed to the host UI. */
export interface EffectiveSettings {
  download_concurrency: number;
  download_timeout_seconds: number;
  manifest_ttl_hours: number;
  manifest_poll_seconds: number;
  telemetry_enabled: boolean;
}

/** File shape — a partial subset of EffectiveSettings. */
type PersistedSettings = Partial<EffectiveSettings>;

export const SETTINGS_DIR = process.env.CODEX_SKILLS_SETTINGS_DIR
  ? resolve(process.env.CODEX_SKILLS_SETTINGS_DIR)
  : resolve(homedir(), ".codex-skills-mcp");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

/** Zod schemas per field — single source for validation and type inference. */
const SCHEMAS = {
  download_concurrency: z.number().int().min(1).max(64),
  download_timeout_seconds: z.number().int().min(1).max(300),
  manifest_ttl_hours: z.number().min(0).max(168),
  manifest_poll_seconds: z.number().int().min(0).max(3600),
  telemetry_enabled: z.boolean(),
};

const VALUES_SCHEMA = z.object(SCHEMAS).strict();

/** Field definitions shared by read/update validation (single source). */
const FIELDS: Record<keyof EffectiveSettings, { schema: (typeof SCHEMAS)[keyof EffectiveSettings]; title: string; description?: string }> = {
  download_concurrency: {
    schema: SCHEMAS.download_concurrency,
    title: "下载并发数",
    description: "同时下载技能文件的数量（1–64）。",
  },
  download_timeout_seconds: {
    schema: SCHEMAS.download_timeout_seconds,
    title: "下载超时（秒）",
    description: "每个技能文件下载请求的超时时间（1–300 秒）。",
  },
  manifest_ttl_hours: {
    schema: SCHEMAS.manifest_ttl_hours,
    title: "缓存有效期（小时）",
    description:
      "技能清单和已缓存文件在重新校验前保持可信的时长。0 表示永不过期，最大 168 小时；数值越低，越早获取上游更新。",
  },
  manifest_poll_seconds: {
    schema: SCHEMAS.manifest_poll_seconds,
    title: "新鲜度检查间隔（秒）",
    description:
      "搜索或生成计划时，以受控频率检查技能清单更新的间隔；0 表示关闭。",
  },
  telemetry_enabled: {
    schema: SCHEMAS.telemetry_enabled,
    title: "匿名使用统计",
    description:
      "用于维护技能库：默认开启，升级后会一次性补齐现有累计使用次数，后续每日上传新增次数。仅含技能名称和成功使用次数，不含搜索词、任务内容、文件路径或调用时间。关闭后仅停止上传，本地累计调用和已使用记录会继续保留。",
  },
};

function loadPersisted(): PersistedSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    const data: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    // Migration: "cn_mirror" was a dead flag (parsed but never consumed by
    // any download logic) removed in 1.5.0-beta.3. Strip it from legacy
    // files so it disappears on the next persist instead of lingering in
    // the settings UI as a misleading no-op toggle.
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const valid: PersistedSettings = {};
    for (const key of Object.keys(SCHEMAS) as (keyof EffectiveSettings)[]) {
      const value = (data as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const parsed = SCHEMAS[key].safeParse(value);
      if (parsed.success) (valid as Record<string, unknown>)[key] = parsed.data;
      else console.error(`[codex-skills-mcp] Ignoring invalid persisted setting "${key}"`);
    }
    return valid;
  } catch (err) {
    console.error(`[codex-skills-mcp] Could not read settings file, using defaults: ${err}`);
    return {};
  }
}

function persist(partial: PersistedSettings): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const tmp = `${SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(partial, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, SETTINGS_PATH);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Config-derived defaults for every field. */
function defaultsFromConfig(config: Config): EffectiveSettings {
  return {
    download_concurrency: config.downloadConcurrency,
    download_timeout_seconds: config.downloadTimeout / 1000,
    manifest_ttl_hours: config.manifestTTL / 3_600_000,
    manifest_poll_seconds: config.manifestPollMs / 1000,
    telemetry_enabled: config.telemetryEnabled ?? true,
  };
}

/** Push effective settings back onto the live Config (read at call time). */
function applyToConfig(config: Config, s: EffectiveSettings): void {
  config.downloadConcurrency = s.download_concurrency;
  config.downloadTimeout = s.download_timeout_seconds * 1000;
  config.manifestTTL = Math.round(s.manifest_ttl_hours * 3_600_000);
  config.manifestPollMs = s.manifest_poll_seconds * 1000;
  config.telemetryEnabled = s.telemetry_enabled;
}

/**
 * Startup overlay only: persisted settings apply to fields the user did NOT
 * set explicitly on the command line this run. Precedence: CLI > persisted
 * settings > defaults. (Runtime settings.update still applies every field —
 * it is an explicit user action after startup.)
 */
function applyPersistedSelective(config: Config, s: EffectiveSettings): void {
  const ex = config.explicitCli ?? new Set<string>();
  if (!ex.has("download_concurrency")) config.downloadConcurrency = s.download_concurrency;
  if (!ex.has("download_timeout_seconds")) config.downloadTimeout = s.download_timeout_seconds * 1000;
  if (!ex.has("manifest_ttl_hours")) config.manifestTTL = Math.round(s.manifest_ttl_hours * 3_600_000);
  if (!ex.has("manifest_poll_seconds")) config.manifestPollMs = s.manifest_poll_seconds * 1000;
  if (!ex.has("telemetry_enabled")) config.telemetryEnabled = s.telemetry_enabled;
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
  applyPersistedSelective(config, effective(config, loadPersisted()));
}

/**
 * Register the settings extension plus the "refresh skills list" tool action
 * on the given OpenAIExtensions facade.
 */
export function registerOpenAISettings(
  server: McpServer,
  extensions: OpenAIExtensions,
  config: Config,
  searchEngine: SkillSearchEngine,
  telemetry?: UsageTelemetry
): void {
  extensions.settings.register({
    readTool: "settings.read",
    updateTool: "settings.update",
    fields: FIELDS,
    layout: [
      {
        kind: "group",
        title: "下载与缓存",
        items: [
          { kind: "property", property: "download_concurrency" },
          { kind: "property", property: "download_timeout_seconds" },
          { kind: "property", property: "manifest_ttl_hours" },
          { kind: "property", property: "manifest_poll_seconds" },
        ],
      },
      {
        kind: "group",
        title: "隐私",
        items: [{ kind: "property", property: "telemetry_enabled" }],
      },
      {
        kind: "group",
        title: "维护",
        items: [
          {
            kind: "tool",
            tool: "refresh_skills_list",
            title: "刷新技能列表",
            description: "立即从远程源重新下载技能清单，获取最新收录的技能。",
          },
        ],
      },
    ],
    // Config is shared by all HTTP sessions and already includes the startup
    // CLI/persisted precedence. Re-reading disk here would hide CLI overrides
    // and retaining a per-session snapshot would overwrite newer updates.
    read: () => defaultsFromConfig(config),
    update: (set) => {
      const next = { ...defaultsFromConfig(config), ...set };
      // Full validation (cross-field rules would also live here).
      const parsed: EffectiveSettings = VALUES_SCHEMA.parse(next);
      // Persist explicit UI changes only; unrelated CLI overrides belong to
      // this process and should not silently become defaults for future runs.
      persist({ ...loadPersisted(), ...(set as Partial<EffectiveSettings>) });
      applyToConfig(config, parsed);
      if (telemetry) {
        if (parsed.telemetry_enabled) telemetry.enable();
        else telemetry.disable();
      }
      logEvent("info", "settings_updated", { detail: JSON.stringify(set) });
      console.error(`[codex-skills-mcp] Settings updated: ${JSON.stringify(set)}`);
      return defaultsFromConfig(config);
    },
  });

  // Tool action rendered as a button in the ChatGPT settings panel. Regular
  // tool semantics per spec: accepts {}, ChatGPT shows the text response in
  // a tooltip after a spinner.
  server.registerTool(
    "refresh_skills_list",
    {
      title: "刷新技能列表",
      description:
        "立即从远程源重新下载技能清单，获取最新收录的技能。" +
        "本地技能库只从磁盘读取清单，因此不会发起远程下载。",
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (typeof searchEngine.refreshManifest !== "function") {
        return {
          content: [
            {
              type: "text" as const,
              text: "本地模式：技能清单直接从磁盘读取。请更新 skills_manifest.json 后重新运行。",
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
              ? `技能清单已刷新：共 ${total} 个技能，${categories.length} 个分类。`
              : `清单刷新被跳过或失败（缓存仍有效或网络异常）。当前索引：${total} 个技能。`,
          },
        ],
      };
    }
  );
}
