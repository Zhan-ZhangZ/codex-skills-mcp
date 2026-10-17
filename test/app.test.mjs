import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const template = await readFile(new URL("app-src/index.html", root), "utf8");
const bundle = await build({
  entryPoints: [new URL("app-src/controller.ts", root).pathname],
  bundle: true, platform: "browser", format: "iife", write: false,
  define: { __APP_VERSION__: JSON.stringify("test") },
});
const source = bundle.outputFiles[0].text;
const skill = (name) => ({ name, description: name + " description", cached: false });
const home = { totalSkills: 2, top: [skill("alpha"), skill("beta")], categories: [{ name: "tools", skill_count: 2 }] };

class Element {
  hidden = false;
  disabled = false;
  children = [];
  textContent = "";
  value = "";
  dataset = {};
  attributes = {};
  listeners = new Map();
  style = { setProperty() {} };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, event = {}) { return this.listeners.get(name)?.({ target: this, preventDefault() {}, ...event }); }
}

function harness() {
  const elements = new Map([...template.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const sent = [];
  const listeners = new Map();
  const timers = new Map();
  let sequence = 0;
  const window = {
    parent: { postMessage(message) { sent.push(message); } },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    scrollTo() {},
  };
  const document = { getElementById: (id) => elements.get(id), createElement: () => new Element(), documentElement: new Element() };
  vm.runInNewContext(source, {
    window, document, console,
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  const reply = async (request, result, error) => {
    assert.ok(request, "request exists");
    await listeners.get("message")?.({ source: window.parent, data: { jsonrpc: "2.0", id: request.id, result, error } });
    await flush();
  };
  const latest = (method) => sent.findLast((message) => message.method === method && message.id);
  const latestTool = (name) => sent.findLast((message) =>
    message.method === "tools/call" && message.params?.name === name && message.id);
  const toolRequests = (name) => sent.filter((message) =>
    message.method === "tools/call" && message.params?.name === name);
  const node = (id) => elements.get(id);
  return {
    node, sent, reply, latest, latestTool, toolRequests, flush, document,
    async ready() {
      assert.equal(sent.length, 1, "no tool call before initialization");
      assert.equal(sent[0].method, "ui/initialize");
      await reply(sent[0], { protocolVersion: "2026-01-26", hostContext: { theme: "dark" } });
      assert.equal(sent[1].method, "ui/notifications/initialized");
      await reply(latest("tools/call"), { structuredContent: home });
    },
    async search(query, immediate = true) {
      node("search").value = query;
      node("search").dispatch(immediate ? "keydown" : "input", immediate ? { key: "Enter" } : {});
      await flush();
    },
    async tick(delay) {
      for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
      await flush();
    },
    async dispose() { listeners.get("pagehide")?.(); await flush(); },
  };
}

test("app initializes before fetching and applies the host theme", async () => {
  const app = harness(); await app.ready();
  assert.equal(app.document.documentElement.dataset.theme, "dark");
  assert.equal(app.node("search").disabled, false);
  assert.equal(app.node("cards").children.length, 2);
  assert.equal(app.node("content").attributes["aria-busy"], "false");
  await app.dispose();
});

test("typing invalidates an old response before the debounce fires", async () => {
  const app = harness(); await app.ready();
  await app.search("old"); const old = app.latest("tools/call");
  await app.search("new", false);
  await app.reply(old, { structuredContent: { results: [skill("stale")] } });
  assert.equal(app.node("cards-list").children.length, 0);
  assert.equal(app.node("status").textContent, "等待输入…");
  await app.tick(250);
  assert.equal(app.latest("tools/call").params.arguments.query, "new");
  await app.reply(app.latest("tools/call"), { structuredContent: { results: [skill("new-result")] } });
  assert.equal(app.node("cards-list").children[0].children[0].textContent, "new-result");
  await app.dispose();
});

test("search results expose their total and continue without duplicates", async () => {
  const app = harness(); await app.ready();
  await app.search("broad");
  const first = app.latestTool("skills.query");
  assert.equal(first.params.arguments.offset, undefined);
  await app.reply(first, { structuredContent: {
    results: [skill("alpha"), skill("beta")], total: 4, offset: 0, has_more: true,
  } });
  assert.equal(app.node("count").textContent, "2/4 结果");
  assert.equal(app.node("search-more").hidden, false);
  assert.match(app.node("search-more").textContent, /2\/4/);

  app.node("search-more").onclick(); await app.flush();
  const second = app.latestTool("skills.query");
  assert.equal(second.params.arguments.offset, 2);
  assert.equal(second.params.arguments.query, "broad");
  await app.reply(second, { structuredContent: {
    results: [skill("gamma"), skill("delta")], total: 4, offset: 2, has_more: false,
  } });
  assert.equal(app.node("cards-list").children.length, 4);
  assert.deepEqual(app.node("cards-list").children.map((item) => item.children[0].textContent),
    ["alpha", "beta", "gamma", "delta"]);
  assert.equal(app.node("search-more").hidden, true);
  await app.dispose();
});

test("detail back returns to its search and successful preview updates cache badge", async () => {
  const app = harness(); await app.ready();
  await app.search("needle");
  await app.reply(app.latest("tools/call"), { structuredContent: { results: [skill("alpha")] } });
  app.node("cards-list").children[0].onclick(); await app.flush();
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
  assert.equal(app.node("d-cached").textContent, "已完整缓存");
  app.node("back").onclick(); await app.flush();
  assert.equal(app.node("heading").textContent, "搜索“needle”");
  assert.equal(app.node("search").value, "needle");
  assert.equal(app.toolRequests("skills.query").at(-1).params.arguments.query, "needle");
  assert.equal(app.node("cards-list").children[0].children[0].textContent, "alpha");
  await app.dispose();
});

test("late detail content never replaces a different skill preview", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const alpha = app.latest("resources/read");
  app.node("back").onclick(); await app.flush();
  app.node("cards").children[1].onclick(); await app.flush();
  const beta = app.latest("resources/read");
  await app.reply(beta, { contents: [{ text: "# Beta" }] });
  await app.reply(alpha, { contents: [{ text: "# Alpha" }] });
  assert.equal(app.node("d-md").textContent, "# Beta");
  assert.equal(app.node("heading").textContent, "beta");
  await app.dispose();
});

test("retry preserves the failing query and displays server errors", async () => {
  const app = harness(); await app.ready();
  await app.search("broken");
  await app.reply(app.latest("tools/call"), { isError: true, content: [{ type: "text", text: "temporarily unavailable" }] });
  assert.match(app.node("status").textContent, /temporarily unavailable/);
  assert.equal(app.node("retry").hidden, false);
  app.node("retry").onclick(); await app.flush();
  assert.equal(app.latest("tools/call").params.arguments.query, "broken");
  await app.reply(app.latest("tools/call"), { structuredContent: { results: [] } });
  assert.equal(app.node("empty").hidden, false);
  assert.equal(app.node("retry").hidden, true);
  await app.dispose();
});

test("IME composition emits one query only after composition ends", async () => {
  const app = harness(); await app.ready();
  const before = app.sent.length;
  app.node("search").dispatch("compositionstart");
  await app.search("she", false); await app.tick(250);
  assert.equal(app.sent.length, before);
  app.node("search").value = "设计";
  app.node("search").dispatch("compositionend"); await app.tick(250);
  assert.equal(app.latest("tools/call").params.arguments.query, "设计");
  await app.dispose();
});

test("duplicate attachment clicks send once and navigation ignores completion", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const first = app.node("d-attach").onclick();
  const second = app.node("d-attach").onclick();
  assert.equal(app.sent.filter((item) => item.method === "ui/update-model-context").length, 1);
  const request = app.latest("ui/update-model-context");
  assert.equal(request.params.structuredContent.skill.uri, "skill://alpha");
  app.node("back").onclick(); await app.flush();
  const status = app.node("status").textContent;
  await app.reply(request, {}); await Promise.all([first, second]);
  assert.equal(app.node("status").textContent, status);
  await app.dispose();
});

test("unsupported handshake blocks tools and offers a connection retry", async () => {
  const app = harness();
  await app.reply(app.latest("ui/initialize"), { protocolVersion: "unsupported" });
  assert.equal(app.sent.some((item) => item.method === "tools/call"), false);
  assert.equal(app.node("search").disabled, true);
  assert.equal(app.node("retry").hidden, false);
  app.node("retry").onclick(); await app.flush();
  assert.equal(app.sent.filter((item) => item.method === "ui/initialize").length, 2);
  await app.dispose();
});

for (const failed of [false, true]) {
  test("attachment " + (failed ? "failure" : "success") + " remains visible after a slower preview", async () => {
    const app = harness(); await app.ready();
    app.node("cards").children[0].onclick(); await app.flush();
    const preview = app.latest("resources/read");
    const attaching = app.node("d-attach").onclick();
    assert.match(app.node("d-attach-status").textContent, /正在将/);
    await app.reply(app.latest("ui/update-model-context"), failed ? { isError: true } : {});
    await attaching;
    const message = app.node("d-attach-status").textContent;
    assert.match(message, failed ? /加入失败/ : /已将「alpha」加入对话上下文/);
    await app.reply(preview, { contents: [{ text: "# Alpha" }] });
    assert.equal(app.node("d-attach-status").textContent, message);
    assert.equal(app.node("d-attach-status").hidden, false);
    assert.equal(app.node("d-md").textContent, "# Alpha");
    assert.equal(app.node("content").attributes["aria-busy"], "false");
    await app.dispose();
  });
}

for (const attachmentFirst of [false, true]) {
  test("preview failure keeps retry available when attachment finishes " + (attachmentFirst ? "first" : "last"), async () => {
    const app = harness(); await app.ready();
    app.node("cards").children[0].onclick(); await app.flush();
    const preview = app.latest("resources/read");
    const attaching = app.node("d-attach").onclick();
    const attachment = app.latest("ui/update-model-context");
    if (attachmentFirst) { await app.reply(attachment, {}); await attaching; }
    await app.reply(preview, undefined, { code: -32603, message: "download pending" });
    if (!attachmentFirst) { await app.reply(attachment, {}); await attaching; }
    assert.match(app.node("d-attach-status").textContent, /已将「alpha」加入对话上下文/);
    assert.match(app.node("status").textContent, /download pending/);
    assert.equal(app.node("retry").hidden, false);
    app.node("retry").onclick(); await app.flush();
    assert.match(app.node("d-attach-status").textContent, /已将「alpha」加入对话上下文/);
    await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
    assert.equal(app.node("retry").hidden, true);
    assert.match(app.node("d-attach-status").textContent, /已将「alpha」加入对话上下文/);
    await app.dispose();
  });
}

test("an attachment completing during preview retry stays associated with that detail", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const attaching = app.node("d-attach").onclick();
  const attachment = app.latest("ui/update-model-context");
  await app.reply(app.latest("resources/read"), undefined, { code: -32603, message: "download pending" });
  app.node("retry").onclick(); await app.flush();
  await app.reply(attachment, {}); await attaching;
  assert.match(app.node("d-attach-status").textContent, /已将「alpha」加入对话上下文/);
  await app.dispose();
});

test("a late attachment result never appears on another skill detail", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const attaching = app.node("d-attach").onclick();
  const attachment = app.latest("ui/update-model-context");
  app.node("back").onclick(); await app.flush();
  app.node("cards").children[1].onclick(); await app.flush();
  assert.equal(app.node("d-attach-status").hidden, true);
  await app.reply(attachment, {}); await attaching;
  assert.equal(app.node("heading").textContent, "beta");
  assert.equal(app.node("d-attach-status").hidden, true);
  assert.equal(app.node("d-attach-status").textContent, "");
  assert.equal(app.node("d-attach").disabled, false);
  await app.dispose();
});

const navEntry = (path, type = "file", extra = {}) => ({
  name: path.split("/").at(-1),
  path,
  type,
  text: path,
  excerpted: false,
  ...(type === "file" ? { size_bytes: 512 } : {}),
  ...extra,
});

const navResult = (view, entries, extra = {}) => ({
  skill_name: "alpha",
  view,
  path: extra.path ?? "",
  query: extra.query ?? "",
  total: extra.total ?? entries.length,
  matched: extra.matched ?? entries.length,
  offset: extra.offset ?? 0,
  returned: entries.length,
  next_cursor: extra.next_cursor ?? null,
  descriptions_excerpted: false,
  entries,
});

const fileResult = (content, extra = {}) => ({
  content,
  size_bytes: extra.size_bytes ?? Buffer.byteLength(content),
  offset: extra.offset ?? 0,
  bytes_returned: Buffer.byteLength(content),
  ...(extra.next_offset === undefined ? {} : { next_offset: extra.next_offset }),
  has_more: extra.next_offset !== undefined,
  binary: false,
});

test("detail exposes cache status, browsable files and file preview", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const statusRequest = app.latestTool("skill_status");
  const previewRequest = app.latest("resources/read");
  await app.reply(statusRequest, { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true,
      catalog_current: true, files_total: 7, files_missing_count: 0, size_bytes: 3072 }],
  }});
  await app.reply(previewRequest, { contents: [{ text: "# Alpha instructions" }] });
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true,
      catalog_current: true, files_total: 8, files_missing_count: 0, size_bytes: 4096 }],
  }});
  assert.equal(app.node("d-cached").textContent, "已完整缓存");
  assert.match(app.node("d-cache-detail").textContent, /8 个文件/);
  assert.equal(app.node("tab-instructions").attributes["aria-selected"], "true");

  app.node("tab-files").onclick(); await app.flush();
  assert.equal(app.node("tab-files").attributes["aria-selected"], "true");
  assert.equal(app.node("explorer-pane").hidden, false);
  const rootFiles = app.latestTool("list_skill_files");
  assert.equal(rootFiles.params.arguments.view, "files");
  assert.equal(rootFiles.params.arguments.path, "");
  await app.reply(rootFiles, { structuredContent: navResult("files", [
    navEntry("docs", "directory"),
    navEntry("README.md"),
  ]) });
  assert.equal(app.node("nav-list").children.length, 2);

  app.node("nav-list").children[0].onclick(); await app.flush();
  const directory = app.latestTool("list_skill_files");
  assert.equal(directory.params.arguments.path, "docs");
  assert.equal(app.node("breadcrumb").children.length, 3);
  await app.reply(directory, { structuredContent: navResult("files", [
    navEntry("docs/guide.md"),
  ], { path: "docs" }) });
  app.node("nav-list").children[0].onclick(); await app.flush();
  const fileRead = app.latestTool("load_skill_file");
  assert.equal(fileRead.params.arguments.file_path, "docs/guide.md");
  assert.equal(fileRead.params.arguments.offset, 0);
  assert.equal(app.node("preview-path").textContent, "docs/guide.md");
  await app.reply(fileRead, { structuredContent: fileResult("# Guide") });
  assert.equal(app.node("preview-content").textContent, "# Guide");
  assert.equal(app.node("preview-more").hidden, true);
  await app.dispose();
});

test("sub-skill search and pagination keep a local page history", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });

  app.node("tab-sub-skills").onclick(); await app.flush();
  const first = app.latestTool("list_skill_files");
  assert.equal(first.params.arguments.view, "sub_skills");
  await app.reply(first, { structuredContent: navResult("sub_skills", [
    navEntry("research/design", "sub_skill", { description: "Research design" }),
  ], { next_cursor: "cursor-2", total: 2 }) });
  assert.equal(app.node("nav-next").hidden, false);

  app.node("nav-next").onclick(); await app.flush();
  const second = app.latestTool("list_skill_files");
  assert.equal(second.params.arguments.cursor, "cursor-2");
  await app.reply(second, { structuredContent: navResult("sub_skills", [
    navEntry("writing/final", "sub_skill", { description: "Final manuscript" }),
  ], { offset: 1, total: 2 }) });
  assert.match(app.node("nav-list").children[0].children[1].children[0].textContent, /final/);
  app.node("nav-prev").onclick(); await app.flush();
  assert.match(app.node("nav-list").children[0].children[1].children[0].textContent, /design/);
  assert.equal(app.toolRequests("list_skill_files").length, 2);

  app.node("nav-search").value = "needle";
  app.node("nav-search").dispatch("keydown", { key: "Enter" });
  await app.flush();
  const searched = app.latestTool("list_skill_files");
  assert.equal(searched.params.arguments.query, "needle");
  assert.equal(searched.params.arguments.path, "");
  await app.reply(searched, { structuredContent: navResult("sub_skills", [
    navEntry("deep/needle", "sub_skill", { description: "The last result" }),
  ], { query: "needle", total: 99, matched: 1 }) });
  assert.match(app.node("nav-count").textContent, /1 个子技能/);
  assert.equal(app.node("nav-next").hidden, true);
  await app.dispose();
});

test("stale directory responses and pre-materialization status cannot overwrite newer UI", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const initialStatus = app.latestTool("skill_status");
  const instructions = app.latest("resources/read");
  await app.reply(instructions, { contents: [{ text: "# Alpha" }] });
  const materializedStatus = app.latestTool("skill_status");
  await app.reply(materializedStatus, { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true,
      catalog_current: true, files_total: 12, files_missing_count: 0, size_bytes: 8192 }],
  }});
  assert.match(app.node("d-cache-detail").textContent, /12 个文件/);
  await app.reply(initialStatus, { structuredContent: {
    requested: 1, complete_count: 0, truncated: false,
    skills: [{ name: "alpha", found: true, cached: false, complete: false,
      files_total: 0, files_missing_count: 0, size_bytes: 0 }],
  }});
  assert.equal(app.node("d-cached").textContent, "已完整缓存");

  app.node("tab-files").onclick(); await app.flush();
  const oldFiles = app.latestTool("list_skill_files");
  app.node("tab-sub-skills").onclick(); await app.flush();
  const newSkills = app.latestTool("list_skill_files");
  await app.reply(newSkills, { structuredContent: navResult("sub_skills", [
    navEntry("fresh/sub", "sub_skill", { description: "fresh" }),
  ]) });
  await app.reply(oldFiles, { structuredContent: navResult("files", [
    navEntry("stale.txt"),
  ]) });
  assert.match(app.node("nav-list").children[0].children[1].children[0].textContent, /sub/);
  await app.dispose();
});

test("an unvalidated cached revision is visibly marked as needing source verification", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 0, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: false,
      catalog_current: false, files_total: 20, files_missing_count: 0, size_bytes: 1000 }],
  }});
  assert.equal(app.node("d-cached").textContent, "缓存版本待验证");
  assert.equal(app.node("d-revision-note").hidden, false);
  assert.match(app.node("d-revision-note").textContent, /本地缓存版本/);
  await app.dispose();
});

test("a slower file preview cannot replace the file selected afterwards", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
  app.node("tab-files").onclick(); await app.flush();
  await app.reply(app.latestTool("list_skill_files"), { structuredContent: navResult("files", [
    navEntry("first.md"),
    navEntry("second.md"),
  ]) });
  app.node("nav-list").children[0].onclick(); await app.flush();
  const first = app.latestTool("load_skill_file");
  app.node("nav-list").children[1].onclick(); await app.flush();
  const second = app.latestTool("load_skill_file");
  await app.reply(second, { structuredContent: fileResult("# Second") });
  await app.reply(first, { structuredContent: fileResult("# First") });
  assert.equal(app.node("preview-path").textContent, "second.md");
  assert.equal(app.node("preview-content").textContent, "# Second");
  await app.dispose();
});

test("large file previews continue by byte offset without losing earlier content", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
  app.node("tab-files").onclick(); await app.flush();
  await app.reply(app.latestTool("list_skill_files"), { structuredContent: navResult("files", [
    navEntry("huge.md"),
  ]) });
  app.node("nav-list").children[0].onclick(); await app.flush();
  const first = app.latestTool("load_skill_file");
  assert.equal(first.params.arguments.max_bytes, 128 * 1024);
  await app.reply(first, { structuredContent: fileResult("第一段😀", { next_offset: 12, size_bytes: 24 }) });
  assert.equal(app.node("preview-more").hidden, false);
  app.node("preview-more").onclick(); await app.flush();
  const second = app.latestTool("load_skill_file");
  assert.equal(second.params.arguments.offset, 12);
  await app.reply(second, { structuredContent: fileResult("第二段", { offset: 12, size_bytes: 24 }) });
  assert.equal(app.node("preview-content").textContent, "第一段😀第二段");
  assert.equal(app.node("preview-more").hidden, true);
  await app.dispose();
});
