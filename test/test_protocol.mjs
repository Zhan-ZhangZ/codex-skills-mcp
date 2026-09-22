/**
 * Protocol smoke test (stdio, end-to-end against the built server).
 * Assertions implement docs/IMPROVEMENT-PLAN.md §8.1.
 *
 * Usage: node test/test_protocol.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const child = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
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

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log("  ✅", label); }
  else { failed++; console.log("  ❌", label); }
}

const call = (name, args) => request("tools/call", { name, arguments: args });

try {
  // 1. initialize — server instructions carry the protocol contract
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "protocol-test", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  console.log("\n[1] initialize / server instructions");
  const ins = init?.instructions ?? "";
  assert(typeof ins === "string" && ins.length > 100, "instructions present and substantial");
  assert(ins.includes("MATERIALIZE") && ins.includes("EXECUTE"), "instructions contain the 5-step protocol");

  // 2. tools/list — 8 tools, protocol-bearing descriptions
  console.log("\n[2] tools/list");
  const tools = (await request("tools/list"))?.tools ?? [];
  const names = tools.map((t) => t.name);
  assert(tools.length === 8, "8 tools registered (got " + tools.length + ": " + names.join(",") + ")");
  const readDesc = tools.find((t) => t.name === "read_skill")?.description ?? "";
  assert(/MANDATORY/.test(readDesc), "read_skill description says MANDATORY");
  assert(/COMPLETE skill/i.test(readDesc), "read_skill description mentions COMPLETE skill download");

  // 3. search_skills — protocol footer + badge support
  console.log("\n[3] search_skills");
  const search = await call("search_skills", { query: "周报 写作 模板", limit: 5 });
  const searchText = (search?.content ?? []).map((c) => c.text).join("\n");
  assert(searchText.includes("PROTOCOL STEP 3"), "search result carries STEP 3 materialize footer");
  assert(searchText.includes("read_skill"), "footer points to read_skill");
  const firstSkill = searchText.match(/\*\*(.+?)\*\*/)?.[1];
  assert(!!firstSkill, "parsed a skill name from results: " + firstSkill);

  // 4. read_skill — Cache & Execution section with a real local_path
  console.log("\n[4] read_skill(" + firstSkill + ")");
  const read = await call("read_skill", { name: firstSkill });
  const readText = (read?.content ?? []).map((c) => c.text).join("\n");
  assert(readText.includes("## Cache & Execution"), "contains '## Cache & Execution' section");
  assert(readText.includes("local_path"), "exposes local_path");
  const localPath = readText.match(/local_path\*\*?:?\s*`?([^\n`]+)/)?.[1];
  assert(!!localPath && existsSync(localPath), "local_path exists on disk: " + localPath);
  assert(readText.includes("PROTOCOL STEP 4"), "carries STEP 4 execute footer");

  // 5. skill_status — deep verification of the just-materialized skill
  console.log("\n[5] skill_status");
  const status = await call("skill_status", { names: firstSkill });
  const statusText = (status?.content ?? []).map((c) => c.text).join("\n");
  assert(statusText.includes("complete"), "reports completeness");
  assert(statusText.includes("local_path"), "reports local_path");

  // 6. diagnostics — audit surface
  console.log("\n[6] diagnostics");
  const diag = await call("diagnostics", { include_log: true, log_lines: 10 });
  const diagText = (diag?.content ?? []).map((c) => c.text).join("\n");
  assert(diagText.includes("Recent tool calls"), "shows recent tool calls");
  assert(/read_skill/.test(diagText), "log includes this session's read_skill call");
  assert(diagText.includes("Local skill cache"), "shows cache stats");

  // 7. activity log file on disk
  console.log("\n[7] activity log file");
  const logDir = join(homedir(), ".codex-skills-cache", "logs");
  const logFiles = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.startsWith("mcp-activity-")) : [];
  assert(logFiles.length > 0, "log files exist: " + logFiles.slice(-2).join(", "));
  if (logFiles.length > 0) {
    const latest = logFiles.sort().at(-1);
    const raw = readFileSync(join(logDir, latest), "utf-8");
    assert(raw.includes('"tool_call"') && raw.includes("read_skill"), "log records tool_call events for read_skill");
  }
} catch (err) {
  failed++;
  console.error("FATAL:", err.message);
} finally {
  child.kill();
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
