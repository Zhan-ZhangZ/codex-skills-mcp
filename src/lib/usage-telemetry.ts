/**
 * Anonymous daily skill-usage telemetry.
 *
 * The existing usage.json file remains the source of truth for cumulative
 * successful reads. This module only stores a cumulative baseline and the
 * positive deltas observed for each UTC day. A disabled setting stops network
 * uploads; local usage tracking and cumulative counters are never affected.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const DEFAULT_TELEMETRY_ENDPOINT =
  "https://gh.251716.xyz/api/skill-usage/v1/batch";

const STATE_VERSION = 1;
const MAX_PENDING_DAYS = 14;
const MAX_SKILLS_PER_DAY = 2000;
const TICK_MS = 15 * 60 * 1000;
const LOCK_WAIT_MS = 1000;
const STALE_LOCK_MS = 60_000;

interface PendingDay {
  batch_id: string;
  counts: Record<string, number>;
}

interface TelemetryState {
  version: 1;
  initialized: boolean;
  source?: string;
  baseline: Record<string, number>;
  days: Record<string, PendingDay>;
}

export interface UsageTelemetryOptions {
  /** Persistent settings directory; telemetry state is stored here. */
  stateDir: string;
  /** Existing cumulative usage file maintained by SkillSearchEngine. */
  usagePath: string;
  pluginVersion: string;
  enabled: boolean;
  endpoint?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  randomUUIDImpl?: () => string;
  autoStart?: boolean;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyState(): TelemetryState {
  return { version: STATE_VERSION, initialized: false, baseline: {}, days: {} };
}

function readCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [name, record] of Object.entries(value)) {
    if (!name || name.length > 500) continue;
    let reads: unknown;
    if (typeof record === "number") reads = record;
    else if (record && typeof record === "object") {
      reads = (record as Record<string, unknown>).reads;
    }
    if (typeof reads === "number" && Number.isSafeInteger(reads) && reads >= 0) {
      out[name] = reads;
    }
  }
  return out;
}

function readState(path: string): TelemetryState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    const value = parsed as Record<string, unknown>;
    if (value.version !== STATE_VERSION) return emptyState();
    const baseline = readCounts(value.baseline);
    const days: Record<string, PendingDay> = {};
    if (value.days && typeof value.days === "object" && !Array.isArray(value.days)) {
      for (const [day, raw] of Object.entries(value.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        if (typeof record.batch_id !== "string") continue;
        const counts = readCounts(record.counts);
        if (Object.keys(counts).length > 0) {
          days[day] = { batch_id: record.batch_id, counts };
        }
      }
    }
    return {
      version: STATE_VERSION,
      initialized: value.initialized === true,
      ...(typeof value.source === "string" ? { source: value.source } : {}),
      baseline,
      days,
    };
  } catch {
    return emptyState();
  }
}

function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

/**
 * A single reporter is shared by all MCP sessions in this process. Cross-
 * process updates are serialized with a short lock so cumulative deltas are
 * not counted twice when several desktop sessions are open.
 */
export class UsageTelemetry {
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly usagePath: string;
  private readonly pluginVersion: string;
  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly randomUUIDImpl: () => string;
  private readonly autoStart: boolean;
  private enabled: boolean;
  private started = false;
  private timer?: ReturnType<typeof setInterval>;
  private flushInFlight?: Promise<void>;
  private uploadController?: AbortController;

  constructor(options: UsageTelemetryOptions) {
    this.stateDir = options.stateDir;
    this.statePath = join(options.stateDir, "skill-usage-telemetry.json");
    this.lockPath = `${this.statePath}.lock`;
    this.usagePath = options.usagePath;
    this.pluginVersion = options.pluginVersion;
    this.enabled = options.enabled;
    this.endpoint = options.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
    this.autoStart = options.autoStart ?? true;
  }

  /** Start local delta capture and the daily upload check. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** Stop uploading immediately while retaining local daily deltas. */
  disable(): void {
    this.enabled = false;
    this.uploadController?.abort();
  }

  /** Resume uploads and immediately flush completed UTC days. */
  enable(): void {
    const wasEnabled = this.enabled;
    this.enabled = true;
    if (!this.started && this.autoStart) this.start();
    else if (!wasEnabled) this.tick();
  }

  /**
   * Read cumulative usage.json and move only positive increases into today's
   * pending bucket. Safe to call after every successful local usage write.
   */
  capture(): void {
    try {
      this.withStateLock((state) => {
        const current = this.readCumulativeUsage();
        if (current === null) return state;

        if (!state.initialized || state.source !== this.usagePath) {
          state.initialized = true;
          state.source = this.usagePath;
          state.baseline = { ...current };
          return state;
        }

        const day = utcDay(this.now());
        let pending = state.days[day];
        let changed = false;
        for (const [name, reads] of Object.entries(current)) {
          if (Object.keys(pending?.counts ?? {}).length >= MAX_SKILLS_PER_DAY && !pending?.counts[name]) {
            continue;
          }
          const previous = state.baseline[name];
          // A new name after initialization, or a reset counter, is attributed
          // to today without ever uploading the pre-existing historical total.
          const delta = previous === undefined || reads < previous
            ? (previous === undefined ? reads : reads)
            : reads - previous;
          state.baseline[name] = reads;
          if (delta > 0) {
            if (!pending) {
              pending = { batch_id: this.randomUUIDImpl(), counts: {} };
              state.days[day] = pending;
            }
            pending.counts[name] = Math.min(
              Number.MAX_SAFE_INTEGER,
              (pending.counts[name] ?? 0) + delta
            );
            changed = true;
          }
        }

        if (changed) this.prune(state);
        return state;
      });
    } catch {
      // Telemetry is best-effort and must never affect skill usage.
    }
  }

  /** Retry all unuploaded completed UTC days. Failures stay local. */
  async flushPending(): Promise<void> {
    if (!this.enabled) return;
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = (async () => {
      try {
        this.capture();
        const today = utcDay(this.now());
        const state = this.readStateUnlocked();
        for (const day of Object.keys(state.days).sort()) {
          if (day >= today || !this.enabled) continue;
          const pending = state.days[day];
          const skills = Object.entries(pending.counts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, count]) => ({ name, count }));
          if (skills.length === 0) {
            await this.removePendingDay(day);
            continue;
          }
          const ok = await this.upload({
            schema_version: 1,
            batch_id: pending.batch_id,
            plugin_version: this.pluginVersion,
            day,
            skills,
          });
          if (!ok || !this.enabled) break;
          await this.removePendingDay(day);
        }
      } finally {
        this.flushInFlight = undefined;
      }
    })();
    return this.flushInFlight;
  }

  private tick(): void {
    this.capture();
    if (this.enabled) void this.flushPending().catch(() => {});
  }

  private readCumulativeUsage(): Record<string, number> | null {
    try {
      if (!existsSync(this.usagePath)) return {};
      return readCounts(JSON.parse(readFileSync(this.usagePath, "utf-8")));
    } catch {
      return null;
    }
  }

  private readStateUnlocked(): TelemetryState {
    return readState(this.statePath);
  }

  private withStateLock(fn: (state: TelemetryState) => TelemetryState): TelemetryState {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = openSync(this.lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS) {
            rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          // The owner may have released the lock; retry immediately.
        }
        if (Date.now() >= deadline) throw new Error("telemetry state lock timeout");
        sleepBriefly();
      }
    }

    try {
      const state = this.readStateUnlocked();
      const updated = fn(state);
      this.writeStateUnlocked(updated);
      return updated;
    } finally {
      closeSync(fd);
      rmSync(this.lockPath, { force: true });
    }
  }

  private writeStateUnlocked(state: TelemetryState): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.${process.pid}.${this.randomUUIDImpl()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
      });
      renameSync(tmp, this.statePath);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private prune(state: TelemetryState): void {
    const keepFrom = utcDay(new Date(this.now().getTime() - MAX_PENDING_DAYS * 86_400_000));
    for (const day of Object.keys(state.days)) {
      if (day < keepFrom) delete state.days[day];
    }
  }

  private async removePendingDay(day: string): Promise<void> {
    this.withStateLock((state) => {
      delete state.days[day];
      return state;
    });
  }

  private async upload(payload: object): Promise<boolean> {
    this.uploadController?.abort();
    const controller = new AbortController();
    this.uploadController = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `codex-skills-mcp/${this.pluginVersion}`,
          "x-codex-skills-telemetry": "1",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return response.ok && response.status === 204;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      if (this.uploadController === controller) this.uploadController = undefined;
    }
  }
}
