// Smoke test for the OpenAI MCP Extensions Phase 1 upgrade
// (structured settings + composer mentions + skill:// resources).
//
// Verifies, over Streamable HTTP:
//   1. initialize result advertises the openai/settings capability
//      (both `extensions` and legacy `experimental` namespaces).
//   2. tools/list includes settings.read / settings.update /
//      refresh_skills_list / search_mentions, and search_mentions carries
//      the mentions/search _meta with app-only visibility.
//   3. settings.read returns a structured SettingsReadResult.
//   4. settings.update persists + returns effective values.
//   5. search_mentions returns skill:// resource links.
//   6. resources/read resolves a skill:// URI to SKILL.md content.
//
// Run:  node test_openai_extensions.mjs
// Requires the server from this branch (dist/ built) — the script starts it.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const PORT = 3461;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

// Isolate settings persistence away from the real ~/.codex-skills-mcp.
const TEST_HOME = mkdtempSync(join(tmpdir(), "csx-ext-home-"));
// Reuse the real skills cache so the test is fast and offline-friendly.
const REAL_CACHE = join(homedir(), ".codex-skills-cache");

const server = spawn(process.execPath, ["dist/index.js", "--http", "--port", String(PORT)], {
  cwd: process.cwd(),
  env: { ...process.env, HOME: TEST_HOME, CODEX_SKILLS_CACHE_DIR: REAL_CACHE },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.error(`  ✘ ${label}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
}

let sid = null;
let nextId = 1;
async function rpc(method, params = {}, notify = false) {
  const body = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = nextId++;
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!notify && res.headers.get("mcp-session-id")) sid = res.headers.get("mcp-session-id");
  // Notifications legitimately return 202 with an empty body.
  if (notify && res.status === 202) return null;
  let json;
  try {
    const payload = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    json = JSON.parse(payload);
  } catch {
    try { json = JSON.parse(raw); } catch {
      console.error(`[rpc] ${method}: status=${res.status} ct=${res.headers.get("content-type")} rawLen=${raw.length} raw=${JSON.stringify(raw.slice(0, 200))}`);
      throw new Error(`${method}: unparseable response`);
    }
  }
  if (json?.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json;
}

async function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args });
}

try {
  // Wait for HTTP readiness
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) { up = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error("server did not become healthy");

  // 1. initialize — capability advertisement
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ext-smoke", version: "1.0" },
  });
  await rpc("notifications/initialized", {}, true);
  const caps = init.result?.capabilities ?? {};
  const capExt = caps?.extensions?.["openai/settings"];
  const capExp = caps?.experimental?.["openai/settings"];
  console.log("\n## 1. Capability advertisement");
  check("extensions['openai/settings'] present", !!capExt, caps);
  check("experimental['openai/settings'] present (legacy path)", !!capExp, caps);
  check("capability names read/update tools", capExt?.readTool === "settings.read" && capExt?.updateTool === "settings.update", capExt);

  // 2. tools/list — new tools + mentions _meta
  const list = await rpc("tools/list");
  const names = list.result?.tools?.map((t) => t.name);
  const mentionsTool = list.result?.tools?.find((t) => t.name === "search_mentions");
  console.log("\n## 2. Tool surface");
  check("settings.read registered", names.includes("settings.read"), names);
  check("settings.update registered", names.includes("settings.update"), names);
  check("refresh_skills_list registered", names.includes("refresh_skills_list"), names);
  check("search_mentions registered", names.includes("search_mentions"), names);
  check("core tools intact (8)", ["search_skills","list_categories","read_skill","load_skill_file","list_skill_files","plan_workflow","skill_status","diagnostics"].every((n) => names.includes(n)), names);
  check("search_mentions _meta mentions/search", mentionsTool?._meta?.["openai/extensions"]?.["mentions/search"] != null, mentionsTool?._meta);
  check("search_mentions app-only visibility", Array.isArray(mentionsTool?._meta?.ui?.visibility) && mentionsTool._meta.ui.visibility.includes("app"), mentionsTool?._meta?.ui);

  // 3. settings.read
  const readRes = await callTool("settings.read", {});
  const readSc = readRes.result?.structuredContent;
  console.log("\n## 3. settings.read");
  check("structured schema/values present", !!readSc?.schema && !!readSc?.values, readSc);
  check("all 5 fields in values", ["cn_mirror","download_concurrency","download_timeout_seconds","manifest_ttl_hours","manifest_poll_seconds"].every((k) => k in (readSc?.values ?? {})), readSc?.values);
  check("layout has 2 groups incl. refresh action", readSc?.layout?.length === 2 && readSc.layout[1].items.some((i) => i.kind === "tool" && i.tool === "refresh_skills_list"), readSc?.layout);

  // 4. settings.update → persists to isolated HOME
  const updRes = await callTool("settings.update", { set: { download_concurrency: 8, cn_mirror: true } });
  const updSc = updRes.result?.structuredContent;
  console.log("\n## 4. settings.update");
  check("updated values returned", updSc?.values?.download_concurrency === 8 && updSc?.values?.cn_mirror === true, updSc?.values);
  const settingsFile = join(TEST_HOME, ".codex-skills-mcp", "settings.json");
  check("settings persisted to disk (isolated HOME)", existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, "utf-8")).download_concurrency === 8, settingsFile);
  const invalid = await callTool("settings.update", { set: { download_concurrency: 999 } });
  check("out-of-range value rejected", !!invalid.error || invalid.result?.isError === true, invalid);
  const reRead = await callTool("settings.read", {});
  check("re-read reflects update", reRead.result?.structuredContent?.values?.download_concurrency === 8);

  // 5. search_mentions
  const men = await callTool("search_mentions", { query: "office word 文档" });
  const items = men.result?.structuredContent?.items ?? [];
  console.log("\n## 5. search_mentions");
  check("returned items array", Array.isArray(items) && items.length > 0, items);
  check("items are skill:// resource_links", items.every((i) => i.type === "resource_link" && i.uri?.startsWith("skill://")), items.slice(0, 3));
  console.log(`    top mentions: ${items.slice(0, 5).map((i) => i.name).join(", ")}`);

  // 5b. butler placement (Phase 2, revised)
  const pinned = await callTool("search_mentions", { query: "" });
  const pinnedItems = pinned.result?.structuredContent?.items ?? [];
  check("empty query: butler pinned first", pinnedItems[0]?.name === "00_codex_skills", pinnedItems[0]);
  check("empty query: butler title flagged", (pinnedItems[0]?.title ?? "").includes("管家"), pinnedItems[0]?.title);
  const vidQ = await callTool("search_mentions", { query: "视频 video" });
  const vidItems = vidQ.result?.structuredContent?.items ?? [];
  check("unrelated query: butler NOT injected", !vidItems.some((i) => i.name === "00_codex_skills"), vidItems[0]?.name);
  const guanQ = await callTool("search_mentions", { query: "管家" });
  const guanItems = guanQ.result?.structuredContent?.items ?? [];
  check("query 管家 finds butler (keyword match)", guanItems.some((i) => i.name === "00_codex_skills"), guanItems.slice(0, 3).map((i) => i.name));
  const routerQ = await callTool("search_mentions", { query: "router" });
  check("query router finds butler", (routerQ.result?.structuredContent?.items ?? []).some((i) => i.name === "00_codex_skills"));
  // search_skills (CLI surface) must remain butler-free
  const cliSearch = await callTool("search_skills", { query: "管家 router butler", limit: 8 });
  const cliText = (cliSearch.result?.content ?? []).map((c) => c.text).join("\n");
  check("search_skills unchanged (no butler)", !cliText.includes("00_codex_skills"), cliText.slice(0, 80));

  // 6. resources/read skill://
  const target = items.find((i) => i.name !== "00_codex_skills")?.name ?? "office-docx";
  const rl = await rpc("resources/list");
  const rlResources = rl.result?.resources ?? [];
  console.log("\n## 6. resources (list + read)");
  check("resources/list pins butler first", rlResources[0]?.uri === "skill://00_codex_skills", rlResources[0]);
  check("resources/list returns the skill catalog", rlResources.length > 100, { count: rlResources.length });
  check("catalog contains skill://human-writing", rlResources.some((r) => r.uri === "skill://human-writing"));
  check("entries carry markdown mimeType", rlResources[0]?.mimeType === "text/markdown", rlResources[0]);
  const rr = await rpc("resources/read", { uri: `skill://${target}` });
  const text = rr.result?.contents?.[0]?.text ?? "";
  check(`resources/read ${target} returns SKILL.md`, text.includes("---") || text.length > 500, { len: text.length, head: text.slice(0, 80) });
  check("mimeType text/markdown", rr.result?.contents?.[0]?.mimeType === "text/markdown");
  const hwRead = await rpc("resources/read", { uri: "skill://human-writing" });
  check("resources/read human-writing non-empty", (hwRead.result?.contents?.[0]?.text ?? "").length > 200);
  // Butler read: single root SKILL.md (Librarian Router), never a full-library fetch
  const butlerRead = await rpc("resources/read", { uri: "skill://00_codex_skills" });
  const butlerText = butlerRead.result?.contents?.[0]?.text ?? "";
  check("butler readable via skill:// (root SKILL.md)", butlerText.includes("Librarian Router") && butlerText.includes("Golden Rules"), { len: butlerText.length, head: butlerText.slice(0, 60) });
  check("butler carries MCP host note (auto-materialize uncached skills)", butlerText.includes("MCP host note") && butlerText.includes("resources/read skill://<name>"), undefined);
  check("butler is single file, not library dump", butlerText.length < 20000, { len: butlerText.length });
  // Supporting-file sub-path (what ChatGPT's model probed as README.md)
  const sub = await rpc("resources/read", { uri: "skill://human-writing/README.md" });
  const subText = sub.result?.contents?.[0]?.text ?? "";
  check("sub-path skill://human-writing/README.md readable", subText.length > 100, { len: subText.length });
  check("sub-path carries markdown mimeType", sub.result?.contents?.[0]?.mimeType === "text/markdown");
  let subNf;
  try {
    await rpc("resources/read", { uri: "skill://human-writing/__nope__.txt" });
    subNf = {};
  } catch (e) {
    subNf = { error: e };
  }
  check("missing sub-path file errors cleanly", !!subNf.error, subNf);
  let nf;
  try {
    await rpc("resources/read", { uri: "skill://__no_such_skill__" });
    nf = {};
  } catch (e) {
    nf = { error: e }; // expected path — server errors cleanly via JSON-RPC
  }
  check("unknown skill errors cleanly", !!nf.error, nf);

  // 7. refresh_skills_list action tool
  const rf = await callTool("refresh_skills_list", {});
  console.log("\n## 7. refresh_skills_list");
  check("action returns summary text", (rf.result?.content?.[0]?.text ?? "").length > 0, rf.result?.content?.[0]?.text?.slice(0, 120));

  console.log(`\n${failures === 0 ? "ALL EXTENSION TESTS PASSED" : `${failures} CHECK(S) FAILED`}`);
} catch (err) {
  failures++;
  console.error("FATAL:", err.stack ?? err.message);
} finally {
  server.kill("SIGTERM");
}

process.exit(failures === 0 ? 0 : 1);
