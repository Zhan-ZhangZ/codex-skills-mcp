/**
 * Freshness e2e test — reproduces the 2026-09-24 incident (newly integrated
 * skill invisible due to a stale manifest inside the TTL window) and verifies
 * the v1.4.1 fix: throttled conditional polling + read_skill self-heal.
 * See docs/IMPROVEMENT-MANIFEST-FRESHNESS.md §5.
 *
 * Usage: node test/test_freshness.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE = join(homedir(), ".codex-skills-cache");
const MANIFEST = join(CACHE, "skills_manifest.json");
const META = join(CACHE, ".codex-skills.manifest.meta.json");
const MANIFEST_BAK = MANIFEST + ".freshness-test.bak";
const META_BAK = META + ".freshness-test.bak";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log("  ✅", label); }
  else { failed++; console.log("  ❌", label); }
}

function startServer() {
  const child = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CODEX_SKILLS_MANIFEST_POLL_SECONDS: "1" },
  });
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString("utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
  return {
    child, request, send,
    init: async () => {
      await request("initialize", {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "freshness-test", version: "1.0.0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    },
    call: (name, args) => request("tools/call", { name, arguments: args }),
    stop: () => { try { child.kill(); } catch {} },
  };
}

const textOf = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// --- backup & poison -------------------------------------------------------
const hadMeta = existsSync(META);
copyFileSync(MANIFEST, MANIFEST_BAK);
if (hadMeta) copyFileSync(META, META_BAK);

const original = JSON.parse(readFileSync(MANIFEST_BAK, "utf-8"));
const stale = original.filter((e) => !/chubby/i.test(e.name + " " + (e.description || "")));
if (stale.length === original.length) {
  console.log("FATAL: test requires a manifest containing chubbyskills; rerun after the repo integration.");
  process.exit(1);
}

try {
  // Poison: stale manifest with a FRESH mtime (the exact incident condition:
  // TTL sees a young file, so startup refresh is skipped).
  writeFileSync(MANIFEST, JSON.stringify(stale, null, 2), "utf-8");
  rmSync(META, { force: true });
  console.log(`[setup] poisoned manifest: ${stale.length}/${original.length} entries (chubby removed)`);

  // --- Case A: search recovers via throttled poll ---------------------------
  console.log("\n[A] search_skills on a stale index (fresh mtime, no meta)");
  const a = startServer();
  await a.init();
  const search = await a.call("search_skills", { query: "chubbyskills 中文内容采集", limit: 5 });
  const searchText = textOf(search);
  assert(/chubbyskills/i.test(searchText), "search finds the newly integrated skill");
  assert(searchText.includes("[cached]") || searchText.includes("score"), "well-formed search result");
  a.stop();

  // --- Case B: read_skill self-heals without a prior search -----------------
  console.log("\n[B] read_skill directly on a re-poisoned index");
  writeFileSync(MANIFEST, JSON.stringify(stale, null, 2), "utf-8");
  rmSync(META, { force: true });
  const b = startServer();
  await b.init();
  await new Promise((r) => setTimeout(r, 1500)); // let poll interval elapse
  const read = await b.call("read_skill", { name: "chubbyskills" });
  const readText = textOf(read);
  assert(/# Skill: chubbyskills/.test(readText), "read_skill self-heals (finds + downloads the skill)");
  assert(readText.includes("## Cache & Execution"), "returned the Cache & Execution section");
  b.stop();

  // --- Case C: activity log records the refresh ------------------------------
  console.log("\n[C] activity log evidence");
  const logDir = join(CACHE, "logs");
  const files = existsSync(logDir) ? readdirSorted(logDir) : [];
  const latest = files.at(-1);
  const raw = latest ? readFileSync(join(logDir, latest), "utf-8") : "";
  assert(raw.includes("manifest_poll"), "log contains manifest_poll events");
  assert(raw.includes("manifest_refresh"), "log contains manifest_refresh events");
} catch (err) {
  failed++;
  console.error("FATAL:", err.message);
} finally {
  // --- restore ---------------------------------------------------------------
  copyFileSync(MANIFEST_BAK, MANIFEST);
  rmSync(MANIFEST_BAK, { force: true });
  if (hadMeta) copyFileSync(META_BAK, META); else rmSync(META, { force: true });
  rmSync(META_BAK, { force: true });
  console.log("\n[teardown] original manifest restored");
}

function readdirSorted(dir) {
  return readdirSync(dir).filter((f) => f.startsWith("mcp-activity-")).sort();
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
