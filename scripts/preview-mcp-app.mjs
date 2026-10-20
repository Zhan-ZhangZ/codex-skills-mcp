#!/usr/bin/env node
/** Render the built MCP App in Chrome with a deterministic mock host. */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const { values } = parseArgs({ options: {
  state: { type: "string", default: "files" },
  output: { type: "string", default: "docs/assets/app-preview.png" },
  width: { type: "string", default: "430" },
  height: { type: "string", default: "900" },
} });
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [appHtml, previewImageBase64] = await Promise.all([
  readFile(resolve(root, "assets/app.html"), "utf8"),
  readFile(resolve(root, "app-src/brand-logo.png")).then((bytes) => bytes.toString("base64")),
]);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const skills = [
  { name: "awesome-journal-skills", description: "期刊选择、研究设计、投稿与审稿流程。", cached: true,
    category: "12_学术论文与科研图表", size_bytes: 18 * 1024 * 1024,
    match_reasons: ["关键词「论文」", "推荐词匹配"],
    reads: 18, failures: 0, last_used_at: Date.now() - 12 * 60_000 },
  { name: "officecli", description: "创建和分析 Office 文档、表格与演示文稿。", cached: false,
    category: "04_内容创作与文档处理", size_bytes: 93 * 1024 * 1024,
    match_reasons: ["关键词「PPT」", "交付物「PPT」"],
    reads: 11, failures: 1, last_used_at: Date.now() - 2 * 3_600_000 },
  { name: "webapp-testing", description: "使用 Playwright 验证本地 Web 应用。", cached: true,
    category: "01_代码工程与架构", size_bytes: 6 * 1024 * 1024,
    match_reasons: ["关键词「测试」"],
    reads: 7, failures: 0, last_used_at: Date.now() - 26 * 3_600_000 },
  { name: "codex-ppt-skill", description: "把文章与研究报告组织成统一视觉风格的演示文稿。", cached: false,
    category: "05_多媒体与设计资产", size_bytes: 43 * 1024 * 1024,
    match_reasons: ["关键词「PPT」", "交付物「PPT」"],
    reads: 5, failures: 0, last_used_at: Date.now() - 3 * 86_400_000 },
  { name: "humanizer", description: "清理模板化表达，同时保留事实、语气与作者声音。", cached: true,
    category: "04_内容创作与文档处理", size_bytes: 2 * 1024 * 1024,
    match_reasons: ["关键词「改写」"],
    reads: 3, failures: 0, last_used_at: Date.now() - 8 * 86_400_000 },
  { name: "blender-mcp", description: "通过 MCP 控制 Blender，完成场景、材质与镜头搭建。", cached: false,
    category: "05_多媒体与设计资产", size_bytes: 14 * 1024 * 1024,
    match_reasons: ["关键词「3D」"],
    reads: 2, failures: 0, last_used_at: Date.now() - 16 * 86_400_000 },
];
const categories = [
  { name: "代码工程与架构", skill_count: 20 },
  { name: "DevOps 与自动化", skill_count: 12 },
  { name: "效率工具与协同管理", skill_count: 33 },
  { name: "内容创作与文档处理", skill_count: 35 },
  { name: "多媒体与设计资产", skill_count: 57 },
  { name: "商业与专业领域", skill_count: 49 },
  { name: "智能体框架与协同", skill_count: 28 },
  { name: "MCP 服务开发与评估", skill_count: 7 },
  { name: "Composio 集成服务", skill_count: 2 },
  { name: "Skill 开发脚手架与安装器", skill_count: 11 },
  { name: "API 与第三方应用集成", skill_count: 18 },
  { name: "学术论文与科研图表", skill_count: 15 },
  { name: "社科研究与实证工具", skill_count: 6 },
  { name: "财务发票提取与归档", skill_count: 4 },
  { name: "优质 GitHub 项目清单", skill_count: 1 },
];
const totalSkills = categories.reduce((total, category) => total + category.skill_count, 0);
const historySeed = [
  { query: "把这张产品照片反推成可直接使用的生图中英双语提示词，重点还原灯光、材质和镜头层次", at: Date.now() - 3_600_000 },
  { query: "officecli 生成季度报表", at: Date.now() - 86_400_000 },
  { query: "webapp-testing", at: Date.now() - 3 * 86_400_000 },
  { query: "humanizer 英文改写", at: Date.now() - 4 * 86_400_000 },
  { query: "codex-ppt-skill", at: Date.now() - 5 * 86_400_000 },
  { query: "academic-research-skills-codex 文献综述", at: Date.now() - 6 * 86_400_000 },
  { query: "image-prompt-reverse 反推提示词", at: Date.now() - 7 * 86_400_000 },
  { query: "blender-mcp 场景搭建", at: Date.now() - 8 * 86_400_000 },
];

function navigationArguments(args) {
  if (args.view === "sub_skills") {
    const entries = [
      { name: "Research design", path: "research/design", type: "sub_skill", description: "研究问题、变量、样本与识别策略。", text: "", excerpted: false },
      { name: "Journal selection", path: "journals/selection", type: "sub_skill", description: "按主题、周期和审稿偏好筛选期刊。", text: "", excerpted: false },
      { name: "Submission", path: "writing/submission", type: "sub_skill", description: "投稿材料、cover letter 与系统检查。", text: "", excerpted: false },
      { name: "Review response", path: "writing/review-response", type: "sub_skill", description: "逐条回应审稿意见并维护修改记录。", text: "", excerpted: false },
    ].filter((entry) => !args.query || `${entry.name} ${entry.description}`.toLowerCase().includes(args.query.toLowerCase()));
    return {
      skill_name: "awesome-journal-skills", view: "sub_skills", path: "", query: args.query ?? "",
      total: 4166, matched: entries.length, offset: 0, returned: entries.length,
      next_cursor: entries.length > 2 ? "mock-next" : null, descriptions_excerpted: false, entries,
    };
  }
  const docs = args.path === "docs";
  const entries = docs ? [
    { name: "getting-started.md", path: "docs/getting-started.md", type: "file", size_bytes: 12800, text: "", excerpted: false },
    { name: "workflow.md", path: "docs/workflow.md", type: "file", size_bytes: 24600, text: "", excerpted: false },
    { name: "api", path: "docs/api", type: "directory", text: "", excerpted: false },
  ] : [
    { name: "docs", path: "docs", type: "directory", text: "", excerpted: false },
    { name: "scripts", path: "scripts", type: "directory", text: "", excerpted: false },
    { name: "references", path: "references", type: "directory", text: "", excerpted: false },
    { name: "SKILL.md", path: "SKILL.md", type: "file", size_bytes: 6400, text: "", excerpted: false },
    { name: "README.md", path: "README.md", type: "file", size_bytes: 3200, text: "", excerpted: false },
    { name: "requirements.txt", path: "requirements.txt", type: "file", size_bytes: 96, text: "", excerpted: false },
    { name: "brand-logo.png", path: "brand-logo.png", type: "file", size_bytes: 18000, text: "", excerpted: false },
    { name: "monthly.xlsx", path: "monthly.xlsx", type: "file", size_bytes: 4096, text: "", excerpted: false },
    { name: "dataset.jsonl", path: "dataset.jsonl", type: "file", size_bytes: 58720256, text: "", excerpted: false },
  ];
  return {
    skill_name: "awesome-journal-skills", view: "files", path: args.path ?? "", query: args.query ?? "",
    total: 2281, matched: entries.length, offset: 0, returned: entries.length,
    next_cursor: "mock-next", descriptions_excerpted: false, entries,
  };
}

const mockHost = `<!doctype html><html><body style="margin:0;background:#111">
<iframe id="app" src="/app.html" style="border:0;width:100vw;height:100vh"></iframe>
<script>
const frame = document.getElementById("app");
const state = ${JSON.stringify(values.state)};
const skills = ${JSON.stringify(skills)};
const categories = ${JSON.stringify(categories)};
const totalSkills = ${JSON.stringify(totalSkills)};
const previewImageBase64 = ${JSON.stringify(previewImageBase64)};
const navigationArguments = ${navigationArguments.toString()};
let history = ${JSON.stringify(historySeed)};
window.__rpcLog = [];
const instructions = "# Awesome Journal Skills\\n\\n## 使用方式\\n\\n先确认研究问题、目标期刊和当前阶段，再读取对应的子技能。\\n\\n[本包 README.md](./README.md)\\n\\n[大管家 SKILL.md](../../../SKILL.md)\\n\\n1. 设计阶段：明确变量、样本和识别策略。\\n2. 选刊阶段：核对范围、周期、开放获取与审稿偏好。\\n3. 写作阶段：按目标期刊结构组织论证。\\n4. 投稿阶段：逐项检查匿名性、附件和格式。\\n\\n> 完整技能已经缓存在本地，可继续查看文件或子技能。\\n\\n\\x3cscript>document.body.dataset.xss='1'\\x3c/script>\\n\\n<a href=\\"javascript:alert(1)\\">unsafe link</a>";
function reply(id, result) { frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*"); }
addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0" || !message.id) return;
  window.__rpcLog.push({ method: message.method, name: message.params?.name, uri: message.params?.uri, args: message.params?.arguments });
  if (message.method === "ui/initialize") return reply(message.id, {
    protocolVersion: "2026-01-26", hostContext: { theme: "dark" },
    hostCapabilities: { updateModelContext: { text: {}, resource: {}, resourceLink: {} } },
  });
  if (message.method === "tools/call") {
    const name = message.params.name;
    const args = message.params.arguments || {};
    if (name === "skills.browse") return reply(message.id, { structuredContent: { totalSkills, top: skills,
      cache_mode: "remote", usage: { total_reads: 46, used_skills: 6, total_failures: 1 }, categories } });
    if (name === "skills.query") return reply(message.id, { structuredContent: { results: skills } });
    if (name === "skills.getSearchHistory") return reply(message.id, { structuredContent: { entries: history } });
    if (name === "skills.recordSearch") {
      const query = String(args.query || "").trim();
      const at = Number(args.at) || Date.now();
      if (query) {
        const last = history[0];
        if (last && at - last.at <= 15_000 &&
            (query.startsWith(last.query) || last.query.startsWith(query))) history.shift();
        history = [{ query, at }, ...history.filter((entry) =>
          entry.query.toLocaleLowerCase() !== query.toLocaleLowerCase())].slice(0, 8);
      }
      return reply(message.id, { structuredContent: { entries: history } });
    }
    if (name === "skills.clearSearchHistory") {
      history = [];
      return reply(message.id, { structuredContent: { entries: history } });
    }
    if (name === "skills.clearCache") return reply(message.id, { structuredContent: {
      name: args.name, found: true, cleared: true, local_path: "/cache/skill",
      files_removed: 2281, bytes_removed: 48234496, cache_mode: "remote",
    } });
    if (name === "skills.previewImage") return reply(message.id, { structuredContent: {
      mime_type: "image/png", size_bytes: 18000, data_base64: previewImageBase64,
    } });
    if (name === "skill_status") {
      if (args.names === "00_codex_skills") return reply(message.id, { structuredContent: {
        requested: 1, complete_count: 1, truncated: false,
        skills: [{ name: "00_codex_skills", found: true, root: true, cacheable: false,
          cached: true, complete: true, catalog_current: true, local_path: "",
          files_total: 1, files_missing_count: 0, size_bytes: 0, completed_at: null }],
      } });
      return reply(message.id, { structuredContent: { requested: 1, complete_count: state === "progress" ? 0 : 1, truncated: false,
        skills: [{ name: "awesome-journal-skills", found: true, cached: state !== "progress", complete: state !== "progress", catalog_current: true,
          local_path: "/cache/awesome-journal-skills",
          files_total: 2281, files_missing_count: state === "progress" ? 1036 : 0, size_bytes: 48234496, completed_at: new Date().toISOString() }] } });
    }
    if (name === "list_skill_files") return reply(message.id, { structuredContent: navigationArguments(args) });
    if (name === "load_skill_file") {
      if (/[.](?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(String(args.file_path || ""))) {
        return reply(message.id, { structuredContent: {
          content: "", size_bytes: 18000, offset: 0, bytes_returned: 0,
          has_more: false, binary: true, mime_type: "image/png",
        } });
      }
      if (/[.]xlsx$/i.test(String(args.file_path || ""))) {
        return reply(message.id, { structuredContent: {
          content: "", size_bytes: 4096, offset: 0, bytes_returned: 0,
          has_more: false, binary: true,
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        } });
      }
      const large = String(args.file_path || "").endsWith("dataset.jsonl");
      const content = large
        ? "{\\"id\\":1,\\"topic\\":\\"research design\\"}\\n{\\"id\\":2,\\"topic\\":\\"journal selection\\"}\\n…"
        : "# Getting started\\n\\n这是文件预览内容。";
      return reply(message.id, { structuredContent: {
        content, size_bytes: large ? 58720256 : 31, offset: args.offset || 0,
        bytes_returned: new TextEncoder().encode(content).length, ...(large ? { next_offset: 131072 } : {}),
        has_more: large, binary: false,
      } });
    }
  }
  if (message.method === "resources/read") {
    const file = !message.params.uri.endsWith("awesome-journal-skills");
    if (!file && state === "progress") {
      frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "notifications/progress", params: {
        progressToken: message.params._meta?.progressToken, progress: 1245, total: 2281,
        message: "Fetching 1245/2281 files for awesome-journal-skills",
      } }, "*");
      return;
    }
    return reply(message.id, { contents: [{ text: file ? "# Getting started\\n\\n这是文件预览内容。" : instructions }] });
  }
  if (message.method === "ui/update-model-context") return reply(message.id, {});
});
const timer = setInterval(() => {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    if (state === "detail" && doc.querySelector("#d-md")?.textContent?.includes("Awesome Journal")) {
      clearInterval(timer);
    }
    if (state === "internal_link") {
      const link = doc.querySelector("#d-md-rendered a[href='./README.md']");
      if (link && doc.querySelector("#file-preview")?.hidden !== false) link.click();
      if (doc.querySelector("#preview-path")?.textContent === "README.md"
        && doc.querySelector("#preview-content")?.textContent?.includes("Getting started")) clearInterval(timer);
    }
    if (state === "butler_link" && !window.__butlerLinkClicked) {
      const link = doc.querySelector("#d-md-rendered a[href='../../../SKILL.md']");
      if (link) { window.__butlerLinkClicked = true; link.click(); }
    }
    if (state === "image_preview") {
      if (doc.querySelector("#d-md")?.textContent?.includes("Awesome Journal")) doc.querySelector("#tab-files")?.click();
      const rows = [...(doc.querySelectorAll("#nav-list .nav-row") || [])];
      const imageRow = rows.find((row) => row.textContent.includes("brand-logo.png"));
      if (imageRow && doc.querySelector("#file-preview")?.hidden !== false) imageRow.click();
      if (doc.querySelector("#preview-image")?.getAttribute("src")?.startsWith("data:image/png;base64,")) {
        clearInterval(timer);
      }
    }
    if (state === "office_preview") {
      if (doc.querySelector("#d-md")?.textContent?.includes("Awesome Journal")) doc.querySelector("#tab-files")?.click();
      const rows = [...(doc.querySelectorAll("#nav-list .nav-row") || [])];
      const officeRow = rows.find((row) => row.textContent.includes("monthly.xlsx"));
      if (officeRow && doc.querySelector("#file-preview")?.hidden !== false) officeRow.click();
      if (doc.querySelector("#preview-open-host")?.hidden === false) clearInterval(timer);
    }
    if (state === "suggest_modal") {
      if (doc.querySelector("#suggest-modal")?.hidden !== false) doc.querySelector("#suggest-skill")?.click();
      if (doc.querySelector("#suggest-modal")?.hidden === false) clearInterval(timer);
    }
    if (state === "files" || state === "file_preview" || state === "large_preview") {
      if (doc.querySelector("#d-md")?.textContent?.includes("Awesome Journal")) doc.querySelector("#tab-files")?.click();
      if (doc.querySelector("#nav-list")?.children.length) {
        if (state === "files") clearInterval(timer);
        else if (state === "large_preview") {
          if (!doc.querySelector("#preview-content")?.textContent?.includes("research design")) doc.querySelector("#nav-list")?.children[6]?.click();
          if (!doc.querySelector("#preview-more")?.hidden) clearInterval(timer);
        } else if (!doc.querySelector("#preview-content")?.textContent?.includes("Getting started")) {
          doc.querySelector("#nav-list")?.children[3]?.click();
        }
        if (state === "file_preview" && doc.querySelector("#preview-content")?.textContent?.includes("Getting started")) clearInterval(timer);
      }
    }
    if (state === "sub_skills") {
      if (doc.querySelector("#d-md")?.textContent?.includes("Awesome Journal")) doc.querySelector("#tab-sub-skills")?.click();
      if (doc.querySelector("#nav-list")?.children.length) clearInterval(timer);
    }
  } catch {}
}, 40);
frame.addEventListener("load", () => {
  const wait = setInterval(() => {
    try {
      const first = frame.contentDocument?.querySelector("#cards .card");
      if (first) {
        if (state !== "home" && state !== "history" && state !== "search_long" && state !== "suggest_modal") first.click();
        if (state === "history") {
          const input = frame.contentDocument?.querySelector("#search");
          input?.focus();
          input?.dispatchEvent(new frame.contentWindow.Event("focus"));
        }
        if (state === "search_long") {
          const input = frame.contentDocument?.querySelector("#search");
          if (input) {
            input.value = "把这张产品照片反推成可直接使用的生图中英双语提示词，重点还原灯光、材质、镜头层次、空间关系和画面情绪";
            input.dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
            input.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          }
        }
        clearInterval(wait);
      }
    } catch {}
  }, 40);
});
</script></body></html>`;

const server = createServer((request, response) => {
  if (request.url === "/app.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(appHtml);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(mockHost);
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
const profile = await mkdtemp(resolve(tmpdir(), "codex-app-preview-"));
const output = resolve(root, values.output);
let child;
try {
  child = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeError = "";
  child.stderr.on("data", (chunk) => { chromeError += chunk; });
  const portFile = join(profile, "DevToolsActivePort");
  let portText;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { portText = await readFile(portFile, "utf8"); break; } catch { await new Promise((wait) => setTimeout(wait, 50)); }
  }
  if (!portText) throw new Error(chromeError || "Chrome DevTools port was not created");
  const port = Number(portText.split(/\r?\n/)[0]);
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = pages.find((page) => page.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome page target is unavailable");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let nextId = 0;
  const pendingCommands = new Map();
  const runtimeErrors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params?.exceptionDetails?.text);
    if (message.id == null) return;
    const pending = pendingCommands.get(message.id);
    if (!pending) return;
    pendingCommands.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    pendingCommands.set(id, { resolve: resolveCommand, reject: rejectCommand });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", {
    width: Number(values.width), height: Number(values.height), deviceScaleFactor: 1, mobile: false,
  });
  await command("Page.navigate", {
    url: `http://127.0.0.1:${address.port}/?state=${encodeURIComponent(values.state)}`,
  });
  const readyExpression = values.state === "progress"
    ? `document.querySelector("#app")?.contentDocument?.querySelector("#d-progress")?.hidden === false`
    : values.state === "detail"
    ? `document.querySelector("#app")?.contentDocument?.querySelector("#d-md")?.textContent?.includes("Awesome Journal")`
    : values.state === "internal_link"
    ? `document.querySelector("#app")?.contentDocument?.querySelector("#preview-content")?.textContent?.includes("Getting started")`
    : values.state === "butler_link"
    ? `document.querySelector("#app")?.contentDocument?.querySelector("#heading")?.textContent === "00_codex_skills" && document.querySelector("#app")?.contentDocument?.querySelector("#d-cached")?.textContent === "全局入口" && window.__rpcLog?.some(request => request.method === "resources/read" && request.uri === "skill://00_codex_skills")`
    : values.state === "image_preview"
    ? `document.querySelector("#app")?.contentDocument?.querySelector("#preview-image")?.getAttribute("src")?.startsWith("data:image/png;base64,")`
    : values.state === "office_preview"
    ? `document.querySelector("#app")?.contentDocument?.querySelector("#preview-open-host")?.hidden === false && document.querySelector("#app")?.contentDocument?.querySelector("#preview-content")?.textContent?.includes("Excel")`
    : values.state === "suggest_modal"
    ? `document.querySelector("#app")?.contentDocument?.querySelector("#suggest-modal")?.hidden === false`
    : values.state === "file_preview"
      ? `document.querySelector("#app")?.contentDocument?.querySelector("#preview-content")?.textContent?.includes("Getting started")`
    : values.state === "large_preview"
      ? `document.querySelector("#app")?.contentDocument?.querySelector("#preview-more")?.hidden === false`
    : values.state === "history"
      ? `document.querySelector("#app")?.contentDocument?.querySelector("#search-history")?.hidden === false && document.querySelector("#app")?.contentDocument?.querySelector("#search-history-list")?.children.length > 0`
    : values.state === "search_long"
      ? `document.querySelector("#app")?.contentDocument?.querySelector("#heading")?.textContent === "搜索结果" && document.querySelector("#app")?.contentDocument?.querySelector("#cards-list")?.children.length > 0`
    : values.state === "home"
      ? `document.querySelector("#app")?.contentDocument?.querySelector("#cards .card") != null`
      : `document.querySelector("#app")?.contentDocument?.querySelector("#nav-list")?.children.length > 0`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const evaluation = await command("Runtime.evaluate", { expression: readyExpression, returnByValue: true });
    if (evaluation.result?.value === true) { ready = true; break; }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  if (!ready) {
    const debug = await command("Runtime.evaluate", {
      expression: `JSON.stringify({ log: window.__rpcLog?.slice(-12), status: document.querySelector("#app")?.contentDocument?.querySelector("#status")?.textContent, empty: document.querySelector("#app")?.contentDocument?.querySelector("#nav-empty")?.textContent, innerWidth: document.querySelector("#app")?.contentWindow?.innerWidth })`,
      returnByValue: true,
    });
    throw new Error(`App did not reach the ${values.state} preview state: ${debug.result?.value} ${runtimeErrors.join(" ")}`);
  }
  // Let the entry animation settle before capturing; otherwise the whole home
  // view is photographed at partial opacity and every colour reads too dark.
  await new Promise((wait) => setTimeout(wait, 650));
  const unsafe = await command("Runtime.evaluate", {
    expression: `(() => { const doc = document.querySelector("#app")?.contentDocument; return Boolean(doc?.body?.dataset.xss || doc?.querySelector("#d-md-rendered script") || [...(doc?.querySelectorAll("#d-md-rendered a") || [])].some(a => a.getAttribute("href")?.startsWith("javascript:"))); })()`,
    returnByValue: true,
  });
  if (unsafe.result?.value === true) throw new Error("Rendered Markdown retained unsafe HTML");
  const shot = await command("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(output, Buffer.from(shot.data, "base64"));
  socket.close();
  await stat(output);
  console.log(output);
} finally {
  if (child?.exitCode == null && child?.signalCode == null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveClose) => child.once("close", resolveClose)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  }
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
