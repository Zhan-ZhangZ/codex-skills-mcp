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

function harness(storage = new Map()) {
  const elements = new Map([...template.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const sent = [];
  const copied = [];
  const listeners = new Map();
  const timers = new Map();
  let sequence = 0;
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  const window = {
    localStorage,
    parent: { postMessage(message) { sent.push(message); } },
    opened: [],
    open(url) { this.opened.push(url); return {}; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    scrollTo() {},
  };
  const document = { getElementById: (id) => elements.get(id), createElement: () => new Element(), documentElement: new Element() };
  const navigator = {
    clipboard: {
      async writeText(text) { copied.push(text); },
    },
  };
  vm.runInNewContext(source, {
    window, document, navigator, console,
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay, repeat: true }); return id; },
    clearInterval: (id) => timers.delete(id),
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
    node, sent, copied, reply, latest, latestTool, toolRequests, flush, document, localStorage, storage,
    async ready(homeData = home) {
      assert.equal(sent.length, 1, "no tool call before initialization");
      assert.equal(sent[0].method, "ui/initialize");
      await reply(sent[0], { protocolVersion: "2026-01-26", hostContext: { theme: "dark" } });
      assert.equal(sent[1].method, "ui/notifications/initialized");
      await reply(latest("tools/call"), { structuredContent: homeData });
    },
    async search(query, immediate = true) {
      node("search").value = query;
      node("search").dispatch(immediate ? "keydown" : "input", immediate ? { key: "Enter" } : {});
      await flush();
    },
    async tick(delay) {
      for (const [id, timer] of timers) if (timer.delay === delay) {
        if (!timer.repeat) timers.delete(id);
        await timer.fn();
      }
      await flush();
    },
    async notify(method, params) {
      await listeners.get("message")?.({ source: window.parent, data: { jsonrpc: "2.0", method, params } });
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
  assert.equal(app.node("count").textContent, "2 顶层技能");
  assert.equal(app.node("stat-total").textContent, "2");
  assert.match(app.node("hero-kicker").textContent, /2 个顶层技能/);
  assert.equal(app.node("content").attributes["aria-busy"], "false");
  await app.dispose();
});

test("footer skill guidance opens a modal and copies the developer email", async () => {
  const app = harness(); await app.ready();
  assert.equal(app.node("suggest-modal").hidden, true);
  app.node("suggest-skill").onclick();
  assert.equal(app.node("suggest-modal").hidden, false);
  assert.match(template, /请将您需要增加补充的技能（有名字最好）功能描述完整发送到开发者邮箱。/);
  assert.match(template, />sidian1025@163\.com</);
  app.node("suggest-copy").onclick();
  await app.flush();
  assert.deepEqual(app.copied, ["sidian1025@163.com"]);
  assert.equal(app.node("suggest-copy-status").textContent, "邮箱已复制");
  app.node("suggest-close").onclick();
  assert.equal(app.node("suggest-modal").hidden, true);
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
  assert.equal(app.node("heading").textContent, "搜索结果");
  assert.equal(app.node("search").value, "needle");
  assert.equal(app.toolRequests("skills.query").at(-1).params.arguments.query, "needle");
  assert.equal(app.node("cards-list").children[0].children[0].textContent, "alpha");
  await app.dispose();
});

test("search history persists, compacts long queries and stays out of the page heading", async () => {
  const storage = new Map();
  const longQuery = "please reverse engineer this reference image into a reusable prompt " + "细节".repeat(40);
  const app = harness(storage);
  await app.ready();
  await app.search(longQuery);
  await app.reply(app.latestTool("skills.query"), { structuredContent: {
    results: [skill("alpha")], total: 1, offset: 0, has_more: false,
  }});
  assert.equal(app.node("heading").textContent, "搜索结果");
  assert.equal(app.node("search").value, longQuery);

  app.node("back").onclick(); await app.flush();
  await app.reply(app.latestTool("skills.browse"), { structuredContent: home });
  assert.equal(app.node("search-history").hidden, true);
  app.node("search").dispatch("focus");
  assert.equal(app.node("search-history").hidden, false);
  const chip = app.node("search-history-list").children[0];
  assert.equal(app.node("search-history-count").textContent, "1");
  assert.equal(app.node("search-history-more").hidden, true);
  assert.equal(chip.title, longQuery);
  assert.ok(chip.textContent.length < longQuery.length);
  assert.match(chip.textContent, /…$/);
  chip.dispatch("click"); await app.flush();
  assert.equal(app.node("search").value, longQuery);
  assert.equal(app.latestTool("skills.query").params.arguments.query, longQuery);
  await app.reply(app.latestTool("skills.query"), { structuredContent: {
    results: [skill("alpha")], total: 1, offset: 0, has_more: false,
  }});
  assert.equal(app.node("heading").textContent, "搜索结果");
  app.node("back").onclick(); await app.flush();
  await app.reply(app.latestTool("skills.browse"), { structuredContent: home });
  app.node("search").dispatch("focus");
  app.node("search").dispatch("blur");
  await app.tick(120);
  assert.equal(app.node("search-history").hidden, true);
  app.node("search").dispatch("focus");
  assert.equal(app.node("search-history").hidden, false);

  const persisted = harness(storage);
  await persisted.ready();
  assert.equal(persisted.node("search-history-list").children.length, 1);
  assert.equal(persisted.node("search-history-list").children[0].title, longQuery);
  await persisted.dispose();

  app.node("search-history-clear").onclick();
  assert.equal(app.node("search-history").hidden, true);
  assert.equal(app.node("search-history-list").children.length, 0);
  assert.equal(storage.get("codex-skills.search-history.v1"), "[]");
  await app.dispose();

  const cleared = harness(storage);
  await cleared.ready();
  assert.equal(cleared.node("search-history-list").children.length, 0);
  assert.equal(cleared.node("search-history-count").textContent, "0");
  await cleared.dispose();
});

test("search history shows six recent items and can reveal the remaining saved items", async () => {
  const storage = new Map();
  storage.set("codex-skills.search-history.v1", JSON.stringify(
    Array.from({ length: 8 }, (_, index) => ({
      query: `query ${index + 1}`,
      at: Date.now() - index * 1_000,
    })),
  ));
  const app = harness(storage);
  await app.ready();
  assert.equal(app.node("search-history").hidden, true);
  app.node("search").dispatch("focus");
  assert.equal(app.node("search-history").hidden, false);
  assert.equal(app.node("search-history-count").textContent, "8");
  assert.equal(app.node("search-history-list").children.length, 6);
  assert.equal(app.node("search-history-more").hidden, false);
  assert.equal(app.node("search-history-more").textContent, "更多 2");
  assert.equal(app.node("search-history-more").attributes["aria-expanded"], "false");

  app.node("search-history-more").onclick();
  assert.equal(app.node("search-history-list").children.length, 8);
  assert.equal(app.node("search-history-more").textContent, "收起");
  assert.equal(app.node("search-history-more").attributes["aria-expanded"], "true");

  app.node("search-history-more").onclick();
  assert.equal(app.node("search-history-list").children.length, 6);
  assert.equal(app.node("search-history-more").textContent, "更多 2");
  await app.dispose();
});

test("home surfaces measured usage and the detail cache can be cleared after confirmation", async () => {
  const app = harness();
  await app.ready({
    totalSkills: 2,
    cache_mode: "remote",
    usage: { total_reads: 12, used_skills: 2, total_failures: 1 },
    top: [
      { ...skill("alpha"), cached: true, reads: 9, failures: 0, last_used_at: Date.now() - 62_000 },
      { ...skill("beta"), cached: false, reads: 3, failures: 1, last_used_at: Date.now() - 3_600_000 },
    ],
    categories: [{ name: "tools", skill_count: 2 }],
  });
  assert.equal(app.node("stat-total").textContent, "2");
  assert.equal(app.node("stat-usage").textContent, "12");
  assert.equal(app.node("section-title").textContent, "常用技能");
  assert.match(app.node("usage-summary").textContent, /2 个.*12 次/);
  assert.match(app.node("cards").children[0].children[2].children[1].textContent, /调用 9 次/);

  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true,
      catalog_current: true, files_total: 6, files_missing_count: 0, size_bytes: 4096 }],
  }});
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
  assert.equal(app.node("d-clear-cache").disabled, false);
  app.node("d-clear-cache").onclick(); await app.flush();
  assert.equal(app.node("d-clear-cache").textContent, "再次点击确认");
  assert.match(app.node("status").textContent, /再次点击/);
  app.node("d-clear-cache").onclick(); await app.flush();
  const request = app.latestTool("skills.clearCache");
  assert.equal(request.params.arguments.name, "alpha");
  await app.reply(request, { structuredContent: {
    name: "alpha", found: true, cleared: true, local_path: "/cache/alpha",
    files_removed: 6, bytes_removed: 4096, cache_mode: "remote",
  }});
  assert.equal(app.node("d-cached").textContent, "尚未缓存");
  assert.match(app.node("d-cache-detail").textContent, /6 个文件.*4 KB/);
  assert.equal(app.node("d-clear-cache").disabled, true);
  await app.dispose();
});

test("local source skills do not expose cache deletion", async () => {
  const app = harness();
  await app.ready({ ...home, cache_mode: "local" });
  app.node("cards").children[0].onclick(); await app.flush();
  assert.equal(app.node("d-clear-cache").hidden, true);
  assert.equal(app.node("d-clear-cache").disabled, true);
  await app.dispose();
});

test("instructions default to rendered view and preserve an exact raw toggle", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const text = "---\nname: alpha\ndescription: fixture metadata\n---\n\n# Alpha\n\n- item one\n- item two";
  await app.reply(app.latest("resources/read"), { contents: [{ text }] });
  assert.equal(app.node("d-md").textContent, text);
  assert.doesNotMatch(app.node("d-md-rendered").innerHTML, /fixture metadata/);
  assert.equal(app.node("d-md").hidden, true);
  assert.equal(app.node("d-md-rendered").hidden, false);
  assert.equal(app.node("doc-toggle").textContent, "查看原文");
  app.node("doc-toggle").onclick();
  assert.equal(app.node("d-md").hidden, false);
  assert.equal(app.node("d-md-rendered").hidden, true);
  assert.equal(app.node("doc-toggle").textContent, "返回渲染");
  app.node("doc-toggle").onclick();
  assert.equal(app.node("d-md").hidden, true);
  assert.equal(app.node("d-md-rendered").hidden, false);
  await app.dispose();
});

test("rendered relative links open skill files instead of navigating the iframe", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true,
      catalog_current: true, files_total: 2, files_missing_count: 0, size_bytes: 100 }],
  }});
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha\n\n[README](./README.md)" }] });
  let prevented = false;
  app.node("d-md-rendered").dispatch("click", {
    target: { closest: () => ({ getAttribute: () => "./README.md" }) },
    preventDefault: () => { prevented = true; },
  });
  await app.flush();
  assert.equal(prevented, true);
  assert.equal(app.node("tab-files").attributes["aria-selected"], "true");
  assert.equal(app.latestTool("load_skill_file").params.arguments.file_path, "README.md");
  assert.equal(app.node("file-preview").hidden, false);
  await app.dispose();
});

test("raster images render inline through the app-only image preview tool", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true,
      catalog_current: true, files_total: 2, files_missing_count: 0, size_bytes: 100 }],
  }});
  await app.reply(app.latest("resources/read"), { contents: [{ text: "[Hero](./hero.png)" }] });
  app.node("d-md-rendered").dispatch("click", {
    target: { closest: () => ({ getAttribute: () => "./hero.png" }) },
    preventDefault() {},
  });
  await app.flush();
  await app.reply(app.latestTool("load_skill_file"), { structuredContent: {
    content: "", size_bytes: 68, offset: 0, bytes_returned: 0,
    has_more: false, binary: true, mime_type: "image/png",
  }});
  const imageRequest = app.latestTool("skills.previewImage");
  assert.equal(imageRequest.params.arguments.name, "alpha");
  assert.equal(imageRequest.params.arguments.path, "hero.png");
  await app.reply(imageRequest, { structuredContent: {
    mime_type: "image/png", size_bytes: 68, data_base64: "iVBORw0KGgo=",
  }});
  assert.equal(app.node("preview-content").hidden, true);
  assert.equal(app.node("preview-image-wrap").hidden, false);
  assert.equal(app.node("preview-image").src, "data:image/png;base64,iVBORw0KGgo=");
  assert.match(app.node("preview-media-meta").textContent, /IMAGE\/PNG/);
  await app.dispose();
});

test("the global SKILL.md link routes to the library butler", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true,
      catalog_current: true, files_total: 1, files_missing_count: 0, size_bytes: 100 }],
  }});
  await app.reply(app.latest("resources/read"), { contents: [{ text: "[大管家](../../../SKILL.md)" }] });
  app.node("d-md-rendered").dispatch("click", {
    target: { closest: () => ({ getAttribute: () => "../../../SKILL.md" }) },
    preventDefault() {},
  });
  await app.flush();
  assert.equal(app.latestTool("skill_status").params.arguments.names, "00_codex_skills");
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "00_codex_skills", found: true, root: true, cacheable: false,
      cached: true, complete: true, catalog_current: true, local_path: "",
      files_total: 1, files_missing_count: 0, size_bytes: 0, completed_at: null }],
  }});
  assert.equal(app.node("d-cached").textContent, "全局入口");
  assert.equal(app.node("d-clear-cache").hidden, true);
  assert.match(app.latest("resources/read").params.uri, /^skill:\/\/00_codex_skills$/);
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

test("Office files show metadata and a copyable absolute path instead of ZIP bytes", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  await app.reply(app.latestTool("skill_status"), { structuredContent: {
    requested: 1, complete_count: 1, truncated: false,
    skills: [{ name: "alpha", found: true, cached: true, complete: true, catalog_current: true,
      local_path: "/cache/alpha", files_total: 2, files_missing_count: 0, size_bytes: 1024 }],
  }});
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
  app.node("tab-files").onclick(); await app.flush();
  await app.reply(app.latestTool("list_skill_files"), { structuredContent: navResult("files", [
    navEntry("reports/monthly.xlsx"),
  ]) });
  app.node("nav-list").children[0].onclick(); await app.flush();
  await app.reply(app.latestTool("load_skill_file"), { structuredContent: {
    ...fileResult(""), binary: true, bytes_returned: 0, has_more: false,
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size_bytes: 4096,
  }});
  assert.match(app.node("preview-content").textContent, /Excel 工作簿/);
  assert.doesNotMatch(app.node("preview-content").textContent, /PK/);
  assert.equal(app.node("preview-copy").textContent, "复制完整路径");
  assert.equal(app.node("preview-open-host").hidden, false);
  assert.equal(app.node("preview-more").hidden, true);
  app.node("preview-open-host").onclick(); await app.flush();
  const openRequest = app.latest("openai/files/open");
  assert.equal(openRequest.params.path, "/cache/alpha/reports/monthly.xlsx");
  await app.reply(openRequest, {});
  assert.match(app.node("status").textContent, /已交给 Codex 打开/);
  await app.dispose();
});

test("skill materialization displays live file progress only for the current detail", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const request = app.latest("resources/read");
  const token = request.params._meta.progressToken;
  assert.ok(token);
  await app.notify("notifications/progress", {
    progressToken: token, progress: 3, total: 10, message: "Fetching 3/10 files for alpha",
  });
  assert.equal(app.node("d-progress").hidden, false);
  assert.equal(app.node("d-progress-percent").textContent, "30%");
  assert.equal(app.node("d-progress-meta").textContent, "3 / 10 个文件");
  assert.equal(app.node("d-progress-fill").style.width, "30%");
  assert.equal(app.node("d-progress").className, "download-progress");
  assert.match(app.node("d-cache-detail").textContent, /源仓库下载并校验/);
  await app.notify("notifications/progress", {
    progressToken: "another-skill", progress: 9, total: 10, message: "wrong skill",
  });
  assert.equal(app.node("d-progress-percent").textContent, "30%");
  await app.reply(request, { contents: [{ text: "# Alpha" }] });
  assert.equal(app.node("d-progress").hidden, true);
  await app.dispose();
});

test("progress polling falls back to the app tool when host notifications are unavailable", async () => {
  const app = harness(); await app.ready();
  app.node("cards").children[0].onclick(); await app.flush();
  const request = app.latestTool("skills.progress");
  assert.equal(request.params.arguments.name, "alpha");
  await app.reply(request, { structuredContent: { progress: {
    name: "alpha", done: 4, total: 12, message: "Fetching 4/12 files for alpha",
    updated_at: Date.now(), active: true,
  } } });
  assert.equal(app.node("d-progress").hidden, false);
  assert.equal(app.node("d-progress-percent").textContent, "33%");
  assert.equal(app.node("d-progress-meta").textContent, "4 / 12 个文件");
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
  assert.equal(app.node("d-progress").hidden, true);
  await app.dispose();
});
