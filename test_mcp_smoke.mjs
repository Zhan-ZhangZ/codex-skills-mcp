// Smoke test for codex-skills-mcp v1.2.1 against local skill library
const BASE = "http://127.0.0.1:3456/mcp";
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
  if (!notify && res.headers.get("mcp-session-id")) {
    sid = res.headers.get("mcp-session-id");
  }
  let json = null;
  try {
    // Streamable HTTP may respond with SSE frames: "event: message\ndata: {...}"
    const payload = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    json = JSON.parse(payload);
  } catch {
    try { json = JSON.parse(raw); } catch { json = { raw: raw.slice(0, 300) }; }
  }
  if (json && json.error) {
    throw new Error(`RPC ${method} failed: ${JSON.stringify(json.error)}`);
  }
  return json;
}

function summary(label, text, max = 400) {
  const t = typeof text === "string" ? text : JSON.stringify(text);
  console.log(`\n### ${label}`);
  console.log(`[len=${t.length}]`);
  console.log(t.slice(0, max).replace(/\n{3,}/g, "\n\n"));
}

const skills = [
  {
    name: "academic-research-suite",
    query: "学术论文 研究写作 文献综述 审稿 实验设计 manuscript review",
    file: "SKILL.md",
  },
  {
    name: "source-check",
    query: "验证事实来源 科学核查 引用检查 防伪科学 source verification",
    file: "SKILL.md",
  },
  {
    name: "Scientific Agent Skills",
    query: "AI科学家 科研技能 生物 化学 医学 跨学科 research agent",
    file: "SKILL.md",
  },
];

// 1. initialize
await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "1.0" },
});
console.log(`session: ${sid}`);

// 2. initialized notification
await rpc("notifications/initialized", {}, true);

// 3. tools/list
const list = await rpc("tools/list");
console.log("tools:", list.result?.tools?.map((t) => t.name).join(", "));

// 4. list_categories
const cats = await rpc("tools/call", {
  name: "list_categories",
  arguments: {},
});
summary("list_categories", cats.result?.content?.[0]?.text ?? "", 900);

for (const sk of skills) {
  console.log(`\n==================================================`);
  console.log(`SKILL: ${sk.name}`);

  const search = await rpc("tools/call", {
    name: "search_skills",
    arguments: { query: sk.query, limit: 8 },
  });
  summary(`search_skills("${sk.name}")`, search.result?.content?.[0]?.text ?? "", 1200);

  const read = await rpc("tools/call", {
    name: "read_skill",
    arguments: { name: sk.name },
  });
  const readText = read.result?.content?.[0]?.text ?? "";
  const readOk = readText.includes(`# Skill: ${sk.name}`) && readText.includes("## Instructions");
  summary(`read_skill -> ok=${readOk}`, readText, 500);

  const files = await rpc("tools/call", {
    name: "list_skill_files",
    arguments: { skill_name: sk.name, max_depth: 1 },
  });
  const filesText = files.result?.content?.[0]?.text ?? "";
  summary(`list_skill_files (depth 1)`, filesText, 400);

  const load = await rpc("tools/call", {
    name: "load_skill_file",
    arguments: { skill_name: sk.name, file_path: sk.file },
  });
  const loadText = load.result?.content?.[0]?.text ?? "";
  summary(`load_skill_file(${sk.file})`, loadText, 300);
}

// 5. plan_workflow: a research + verification pipeline
const plan = await rpc("tools/call", {
  name: "plan_workflow",
  arguments: {
    task_description:
      "做一篇学术文献综述，先系统性检索文献，再核对引用与事实来源，最后写成论文并模拟同行评审",
  },
});
summary("plan_workflow", plan.result?.content?.[0]?.text ?? "", 1500);

console.log("\nALL SMOKE TESTS DONE");
