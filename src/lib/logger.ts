/**
 * Best-effort JSONL activity logger.
 *
 * - File per day: <cacheDir>/logs/mcp-activity-YYYY-MM-DD.jsonl
 * - Retention: last 14 files swept at most once per day per process.
 * - NEVER throws: every fs operation is wrapped; logging must not break tools.
 * - Key events are mirrored to stderr for local debugging (MCP-safe: stderr,
 *   never stdout).
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  tool?: string;
  skill?: string;
  duration_ms?: number;
  ok?: boolean;
  detail?: string;
  error?: string;
}

const LOG_FILE_PREFIX = "mcp-activity-";
const RETENTION_FILES = 14;

/** Active log directory; null = file logging disabled (e.g. local mode). */
let logDir: string | null = null;
let lastSweep = 0;

/** Enable file logging under <cacheDir>/logs. Safe to call once at startup. */
export function initLogger(cacheDir: string): void {
  try {
    logDir = join(cacheDir, "logs");
    mkdirSync(logDir, { recursive: true });
  } catch {
    logDir = null;
  }
}

/** True when file logging is active (used by diagnostics output). */
export function loggerActive(): boolean {
  return logDir !== null;
}

/** Log dir path (for diagnostics output). */
export function logDirPath(): string | null {
  return logDir;
}

function sweep(): void {
  if (!logDir) return;
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith(LOG_FILE_PREFIX) && f.endsWith(".jsonl"))
      .sort();
    while (files.length > RETENTION_FILES) {
      unlinkSync(join(logDir, files.shift()!));
    }
  } catch {
    // best-effort
  }
}

/** Append one event. Mirrors to stderr; never throws. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Omit<LogEvent, "ts" | "level" | "event"> = {}
): void {
  const entry: LogEvent = { ts: new Date().toISOString(), level, event, ...fields };

  const mirror = [
    `[codex-skills-mcp] ${level} ${event}`,
    fields.tool ? ` tool=${fields.tool}` : "",
    fields.skill ? ` skill=${fields.skill}` : "",
    fields.error ? ` error=${fields.error}` : "",
  ].join("");
  console.error(mirror);

  if (!logDir) return;
  try {
    const day = entry.ts.slice(0, 10);
    appendFileSync(
      join(logDir, `${LOG_FILE_PREFIX}${day}.jsonl`),
      JSON.stringify(entry) + "\n",
      "utf-8"
    );
    const now = Date.now();
    if (now - lastSweep > 24 * 3600 * 1000) {
      lastSweep = now;
      sweep();
    }
  } catch {
    // best-effort: ignore disk errors entirely
  }
}

/**
 * Read recent events across log files (newest first), optionally filtered by
 * level and/or event type. Returns at most `limit` entries. Never throws.
 */
export function readRecentEvents(options: { limit?: number; level?: LogLevel; event?: string } = {}): LogEvent[] {
  const { limit = 20, level, event } = options;
  if (!logDir || limit <= 0) return [];
  const out: LogEvent[] = [];
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith(LOG_FILE_PREFIX) && f.endsWith(".jsonl"))
      .sort()
      .reverse();
    outer: for (const file of files) {
      let lines: string[];
      try {
        lines = readFileSync(join(logDir!, file), "utf-8").split("\n").filter(Boolean);
      } catch {
        continue;
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        let parsed: LogEvent;
        try {
          parsed = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (level && parsed.level !== level) continue;
        if (event && parsed.event !== event) continue;
        out.push(parsed);
        if (out.length >= limit) break outer;
      }
    }
  } catch {
    // best-effort
  }
  return out;
}

/**
 * Wrap a tool handler with call/result/error logging. Handlers that return
 * error-text instead of throwing should additionally call logEvent themselves
 * in their catch block (see tools/*).
 */
export async function withToolLogging<R>(
  tool: string,
  argSummary: Record<string, unknown>,
  fn: () => Promise<R>
): Promise<R> {
  const startedAt = Date.now();
  logEvent("info", "tool_call", { tool, detail: JSON.stringify(argSummary) });
  try {
    const result = await fn();
    logEvent("info", "tool_result", { tool, ok: true, duration_ms: Date.now() - startedAt });
    return result;
  } catch (err) {
    logEvent("error", "tool_result", {
      tool,
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
