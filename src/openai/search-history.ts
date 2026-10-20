/**
 * Shared search history for the App and every skill tray.
 *
 * The history file lives beside settings.json in the user's Codex Skills
 * state directory, so different MCP processes and conversations share one
 * ordered list instead of creating per-iframe localStorage silos.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { SETTINGS_DIR } from "./settings.js";

export interface SearchHistoryEntry {
  query: string;
  at: number;
}

const HISTORY_PATH = join(SETTINGS_DIR, "search-history.json");
const LOCK_PATH = `${HISTORY_PATH}.lock`;
const LIMIT = 8;
const MERGE_MS = 15_000;
const LOCK_MAX_AGE_MS = 5_000;

const ENTRY = z.object({
  query: z.string().trim().min(1).max(500),
  at: z.number().int().nonnegative(),
});
const FILE = z.object({
  version: z.literal(1),
  entries: z.array(ENTRY).max(LIMIT),
});

function normalize(entries: SearchHistoryEntry[]): SearchHistoryEntry[] {
  const seen = new Set<string>();
  return entries
    .map((entry) => ({
      query: entry.query.trim().slice(0, 500),
      at: entry.at,
    }))
    .filter((entry) => entry.query.length > 0)
    .sort((a, b) => b.at - a.at)
    .filter((entry) => {
      const key = entry.query.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, LIMIT);
}

function readUnlocked(): SearchHistoryEntry[] {
  try {
    if (!existsSync(HISTORY_PATH)) return [];
    const parsed = FILE.safeParse(JSON.parse(readFileSync(HISTORY_PATH, "utf-8")));
    return parsed.success ? normalize(parsed.data.entries) : [];
  } catch {
    return [];
  }
}

function writeUnlocked(entries: SearchHistoryEntry[]): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const tmp = `${HISTORY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tmp, HISTORY_PATH);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function withLock<T>(work: () => T): T {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      closeSync(openSync(LOCK_PATH, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_MAX_AGE_MS) unlinkSync(LOCK_PATH);
      } catch {
        // Another process may have released it between stat and unlink.
      }
      if (Date.now() >= deadline) throw new Error("Search history is busy; retry shortly.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // The lock may already have been cleaned up by the next process.
    }
  }
}

export function readSearchHistory(): SearchHistoryEntry[] {
  return readUnlocked();
}

export function recordSearchHistory(query: string, at = Date.now()): SearchHistoryEntry[] {
  const value = query.trim();
  if (!value) return readUnlocked();
  return withLock(() => {
    const entries = readUnlocked();
    const last = entries[0];
    if (last && at >= last.at && at - last.at <= MERGE_MS &&
        (value.startsWith(last.query) || last.query.startsWith(value))) {
      entries.shift();
    }
    const next = normalize([
      { query: value, at },
      ...entries.filter((entry) => entry.query.toLocaleLowerCase() !== value.toLocaleLowerCase()),
    ]);
    writeUnlocked(next);
    return next;
  });
}

export function clearSearchHistory(): SearchHistoryEntry[] {
  return withLock(() => {
    writeUnlocked([]);
    return [];
  });
}
