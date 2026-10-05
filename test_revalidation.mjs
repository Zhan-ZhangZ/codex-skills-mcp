// Revalidation E2E test — uses the REAL cache and REAL repo (read-only ops
// plus self-healing mutations). Subject skill: curated-github-projects, the
// skill that exposed the original staleness bug (remote project-list.md is
// 19839 bytes / 7 entries; the stale local cache held 3356 bytes / 1 entry).
//
// Scenarios:
//   A. Stale cache → read_skill triggers revalidation → file healed,
//      tree.json gains validatedAt + shas.
//   B. manifestTTL=0 → revalidation disabled → stale served untouched.
//   C. sha-level detection: corrupt the recorded sha AND junk the local
//      file (same size class) → read heals both.
//
// Run: node test_revalidation.mjs

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL_DIR = join(
  homedir(), ".codex-skills-cache",
  "00_全局大管家", "15_优质GitHub项目清单", "curated-github-projects"
);
const TREE = join(SKILL_DIR, ".codex-skills.tree.json");
const LIST = join(SKILL_DIR, "references", "project-list.md");
const BACKUP = `${TREE}.test-backup`;

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✔ ${label}`);
  else { failures++; console.error(`  ✘ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

function startServer(port, ttlSeconds) {
  const args = ["dist/index.js", "--http", "--port", String(port)];
  if (ttlSeconds !== undefined) args.push("--manifest-ttl", String(ttlSeconds));
  const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[srv${port}] ${d}`));
  return child;
}

async function waitHealthy(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let sessionId = null;
let rpcId = 1;
async function rpc(port, method, params = {}, notify = false) {
  const body = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = rpcId++;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!notify && res.headers.get("mcp-session-id")) sessionId = res.headers.get("mcp-session-id");
  if (notify && res.status === 202) return null;
  const raw = await res.text();
  const payload = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
  return JSON.parse(payload || raw);
}

async function handshake(port) {
  sessionId = null;
  await rpc(port, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "reval-test", version: "1.0" },
  });
  await rpc(port, "notifications/initialized", {}, true);
}

async function readSkill(port, name) {
  await handshake(port);
  return rpc(port, "tools/call", { name: "read_skill", arguments: { name } });
}

const readTree = () => JSON.parse(readFileSync(TREE, "utf-8"));
/** Local file size in BYTES (API/tree records are bytes; CJK utf-8 ≈3B/char). */
const listSize = () => (existsSync(LIST) ? statSync(LIST).size : 0);
/** The authoritative remote size recorded for project-list.md in tree.json. */
const recordedListSize = () =>
  readTree().files.find((f) => f.path === "references/project-list.md")?.size ?? -1;

try {
  copyFileSync(TREE, BACKUP);
  const before = listSize();
  console.log(`初始状态: project-list.md = ${before} bytes, validatedAt = ${readTree().validatedAt ?? "(无)"}`);

  // ---- Scenario A: stale → read heals ------------------------------------
  console.log("\n## A. 过期缓存读取 → 重验证自愈");
  {
    const t = readTree();
    t.validatedAt = "2020-01-01T00:00:00.000Z"; // force stale
    writeFileSync(TREE, JSON.stringify(t, null, 2));
    const srv = startServer(3471);
    if (!(await waitHealthy(3471))) throw new Error("server A not healthy");
    const r = await readSkill(3471, "curated-github-projects");
    srv.kill("SIGTERM");
    const text = (r.result?.content ?? []).map((c) => c.text).join("\n");
    check("read_skill 成功", text.includes("## Instructions") || text.length > 200, text.slice(0, 80));
    const after = listSize();
    const t2 = readTree();
    check(`清单已更新到远端版本 (${after} bytes = tree.json 权威记录)`, after === recordedListSize() && after >= 1000, { after, recorded: recordedListSize() });
    check("tree.json 获得新鲜 validatedAt", !!t2.validatedAt && Date.parse(t2.validatedAt) > Date.parse("2026-01-01"));
    check("tree.json 文件条目携带 sha", t2.files.every((f) => typeof f.sha === "string" && f.sha.length >= 40));
    const healedText = readFileSync(LIST, "utf-8");
    check("清单内容与远端一致（含多个项目条目）", (healedText.match(/^[-*]\s|^\|\s|^\s*\d+\./gm) ?? []).length >= 3);
  }

  // ---- Scenario B: TTL=0 disables revalidation ---------------------------
  console.log("\n## B. manifestTTL=0 → 重验证关闭（旧行为）");
  {
    const t = readTree();
    t.validatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(TREE, JSON.stringify(t, null, 2));
    const srv = startServer(3472, 0);
    if (!(await waitHealthy(3472))) throw new Error("server B not healthy");
    const r = await readSkill(3472, "curated-github-projects");
    srv.kill("SIGTERM");
    check("read_skill 仍成功（过期照常服务）", !!r.result?.content);
    check("tree.json 未被重写（validatedAt 仍为 2020）", readTree().validatedAt === "2020-01-01T00:00:00.000Z");
  }

  // ---- Scenario C: sha-level content detection ---------------------------
  console.log("\n## C. SHA 级内容变更检测");
  {
    const origList = readFileSync(LIST, "utf-8");
    // Same-size-class junk in the local file + corrupted recorded sha:
    // size checks alone cannot catch this, sha must.
    writeFileSync(LIST, origList.slice(0, 100) + "\n<!-- LOCAL JUNK (sha-detection test) -->\n" + origList.slice(100));
    const t = readTree();
    const f = t.files.find((x) => x.path === "references/project-list.md");
    const realSha = f.sha;
    f.sha = "0".repeat(40); // simulate "remote content differs from cache"
    t.validatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(TREE, JSON.stringify(t, null, 2));

    const srv = startServer(3473);
    if (!(await waitHealthy(3473))) throw new Error("server C not healthy");
    await readSkill(3473, "curated-github-projects");
    srv.kill("SIGTERM");

    const healed = readFileSync(LIST, "utf-8");
    check("本地污染已被远端真身覆盖（junk 消失）", !healed.includes("LOCAL JUNK"));
    check("内容恢复为远端版本（字节数=权威记录）", statSync(LIST).size === recordedListSize(), { bytes: statSync(LIST).size, recorded: recordedListSize() });
    check("tree.json 的 sha 恢复为真实远端值", readTree().files.find((x) => x.path === "references/project-list.md")?.sha === realSha);
  }

  console.log(`\n${failures === 0 ? "ALL REVALIDATION TESTS PASSED" : `${failures} CHECK(S) FAILED`}`);
} catch (err) {
  failures++;
  console.error("FATAL:", err.stack ?? err.message);
} finally {
  // Self-healing leaves the correct state; backup removed on success path.
  if (existsSync(BACKUP) && failures === 0) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(BACKUP);
  }
  process.exit(failures === 0 ? 0 : 1);
}
