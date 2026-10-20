import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "codex-search-history-"));
process.env.CODEX_SKILLS_SETTINGS_DIR = directory;
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

const moduleUrl = pathToFileURL(fileURLToPath(new URL("../dist/openai/search-history.js", import.meta.url))).href;
const historyModule = await import(`${moduleUrl}?test=${Date.now()}`);

test("shared search history merges, deduplicates and persists outside the App iframe", () => {
  assert.deepEqual(historyModule.readSearchHistory(), []);
  historyModule.recordSearchHistory("alpha", 1_000);
  const merged = historyModule.recordSearchHistory("alpha prompt", 2_000);
  assert.deepEqual(merged.map((entry) => entry.query), ["alpha prompt"]);
  const distinct = historyModule.recordSearchHistory("Alpha prompt", 3_000);
  assert.deepEqual(distinct.map((entry) => entry.query), ["Alpha prompt"]);
  historyModule.recordSearchHistory("beta", 4_000);
  const all = historyModule.readSearchHistory();
  assert.deepEqual(all.map((entry) => entry.query), ["beta", "Alpha prompt"]);
  const persisted = JSON.parse(readFileSync(join(directory, "search-history.json"), "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.entries.length, 2);
  assert.deepEqual(historyModule.clearSearchHistory(), []);
  assert.deepEqual(historyModule.readSearchHistory(), []);
});

test("a second MCP process reads the same shared history file", () => {
  const script = [
    `const { recordSearchHistory } = await import(${JSON.stringify(moduleUrl)});`,
    `recordSearchHistory("from another conversation", 5_000);`,
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CODEX_SKILLS_SETTINGS_DIR: directory },
    stdio: "pipe",
  });
  assert.deepEqual(historyModule.readSearchHistory().map((entry) => entry.query), [
    "from another conversation",
  ]);
  historyModule.clearSearchHistory();
});
