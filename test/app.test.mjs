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
  const node = (id) => elements.get(id);
  return {
    node, sent, reply, latest, flush, document,
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

test("detail back returns to its search and successful preview updates cache badge", async () => {
  const app = harness(); await app.ready();
  await app.search("needle");
  await app.reply(app.latest("tools/call"), { structuredContent: { results: [skill("alpha")] } });
  app.node("cards-list").children[0].onclick(); await app.flush();
  await app.reply(app.latest("resources/read"), { contents: [{ text: "# Alpha" }] });
  assert.equal(app.node("d-cached").textContent, "已缓存");
  app.node("back").onclick(); await app.flush();
  assert.equal(app.node("heading").textContent, "搜索“needle”");
  assert.equal(app.node("search").value, "needle");
  assert.equal(app.latest("tools/call").params.arguments.query, "needle");
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
