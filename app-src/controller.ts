/* codex-skills App frontend — vanilla TS + createAppTransport (official
 * Bits & Bolts controller pattern). Bundled by esbuild into a single IIFE
 * and inlined into index.html by scripts/build-app.mjs. */

import { createAppTransport } from "@openai/mcp-extensions/app/transport";

type SkillCard = { name: string; description: string; cached: boolean };
type Category = { name: string; skill_count: number };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const transport = createAppTransport<Record<string, unknown>>();

const state = {
  view: "home" as "home" | "category" | "search" | "detail",
  category: "",
  query: "",
  detail: null as SkillCard | null,
};

const status = (m: string) => ($("status").textContent = m);

let mode: "inline" | "fullscreen" = "inline";
async function setMode(next: "inline" | "fullscreen") {
  mode = next;
  $("mode").textContent = next === "inline" ? "⛶" : "⧉";
  try {
    await transport.request("ui/request-display-mode", { mode }, 10000);
  } catch {
    /* host may not support mode switching; stay usable */
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const r = (await transport.request(
    "tools/call",
    { name, arguments: args },
    30000
  )) as { structuredContent?: any; isError?: boolean };
  if (r?.isError) throw new Error(`tool ${name} failed`);
  return r?.structuredContent ?? {};
}

async function readSkillMd(name: string): Promise<string> {
  const r = (await transport.request(
    "resources/read",
    { uri: `skill://${encodeURIComponent(name)}` },
    60000
  )) as any;
  const text = r?.contents?.[0]?.text;
  if (typeof text !== "string") throw new Error("SKILL.md unreadable");
  return text.length > 6000 ? text.slice(0, 6000) + "\n…（预览截断）" : text;
}

function card(c: SkillCard): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "card";
  const t = document.createElement("b"); t.textContent = c.name;
  const p = document.createElement("p"); p.textContent = c.description;
  const badge = document.createElement("span");
  badge.className = "badge" + (c.cached ? " on" : "");
  badge.textContent = c.cached ? "已缓存" : "按需下载";
  b.append(t, p, badge);
  b.onclick = () => showDetail(c);
  return b;
}

function renderCards(host: HTMLElement, skills: SkillCard[]) {
  host.textContent = "";
  skills.forEach((s) => host.appendChild(card(s)));
}

function showView(v: typeof state.view) {
  state.view = v;
  $("home").hidden = v !== "home";
  $("list").hidden = v !== "category" && v !== "search";
  $("detail").hidden = v !== "detail";
  $("back").hidden = v === "home";
  $("heading").textContent =
    v === "category" ? state.category :
    v === "search" ? `搜索“${state.query}”` :
    v === "detail" ? (state.detail?.name ?? "技能详情") :
    "Codex Skills 技能库";
  window.scrollTo(0, 0);
}

async function showHome() {
  showView("home");
  status("加载中…");
  try {
    const d = await call("skills.browse", {});
    $("count").textContent = `${d.totalSkills} 技能`;
    renderCards($("cards"), d.top ?? []);
    const cats: Category[] = d.categories ?? [];
    const host = $("cats"); host.textContent = "";
    cats.forEach((c) => {
      const b = document.createElement("button");
      b.className = "cat";
      const n = document.createElement("b"); n.textContent = c.name;
      const s = document.createElement("span"); s.className = "muted";
      s.textContent = `${c.skill_count} 个`;
      b.append(n, s);
      b.onclick = () => showCategory(c.name);
      host.appendChild(b);
    });
    status("就绪");
  } catch (e: any) { status(`加载失败: ${e?.message ?? e}（点击重试）`); }
}

async function showCategory(name: string) {
  state.category = name; showView("category"); status("加载中…");
  try {
    const d = await call("skills.browse", { category: name });
    $("count").textContent = `${d.skills?.length ?? 0} 个`;
    renderCards($("cards-list"), d.skills ?? []);
    status("就绪");
  } catch (e: any) { status(`加载失败: ${e?.message ?? e}`); }
}

async function runSearch(q: string) {
  state.query = q; showView("search"); status("搜索中…");
  try {
    const d = await call("skills.query", { query: q, limit: 24 });
    $("count").textContent = `${d.results?.length ?? 0} 结果`;
    renderCards($("cards-list"), d.results ?? []);
    status("就绪");
  } catch (e: any) { status(`搜索失败: ${e?.message ?? e}`); }
}

async function showDetail(c: SkillCard) {
  state.detail = c; showView("detail");
  $("count").textContent = "";
  $("d-cached").textContent = c.cached ? "已缓存" : "未缓存";
  $("d-cached").className = "badge" + (c.cached ? " on" : "");
  $("d-md").textContent = "加载中…";
  status("");
  try {
    $("d-md").textContent = await readSkillMd(c.name);
  } catch (e: any) {
    $("d-md").textContent = `读取失败：${e?.message ?? e}`;
  }
}

$("d-attach").onclick = async () => {
  const name = state.detail?.name;
  if (!name) return;
  try {
    await transport.request(
      "ui/update-model-context",
      { content: [{ type: "text", text: `已选择技能: ${name}` }] },
      15000
    );
    status(`已将「${name}」加入对话上下文`);
  } catch (e: any) { status(`加入失败: ${e?.message ?? e}`); }
};

$("back").onclick = () =>
  state.view === "detail"
    ? (state.category ? showCategory(state.category) : showHome())
    : $("mode").onclick = () => setMode(mode === "inline" ? "fullscreen" : "inline");

// Entry opened fullscreen from the sidebar? Collapse into the right-side
// panel so the conversation stays primary — the user's preferred form.
setMode("inline");
showHome();

let searchTimer: ReturnType<typeof setTimeout> | undefined;
$("search").addEventListener("input", (ev) => {
  const q = (ev.target as HTMLInputElement).value.trim();
  clearTimeout(searchTimer);
  if (!q) { $("mode").onclick = () => setMode(mode === "inline" ? "fullscreen" : "inline");

// Entry opened fullscreen from the sidebar? Collapse into the right-side
// panel so the conversation stays primary — the user's preferred form.
setMode("inline");
showHome(); return; }
  searchTimer = setTimeout(() => runSearch(q), 300);
});

$("status").addEventListener("click", () => {
  if (($("status").textContent ?? "").includes("失败")) $("mode").onclick = () => setMode(mode === "inline" ? "fullscreen" : "inline");

// Entry opened fullscreen from the sidebar? Collapse into the right-side
// panel so the conversation stays primary — the user's preferred form.
setMode("inline");
showHome();
});

$("mode").onclick = () => setMode(mode === "inline" ? "fullscreen" : "inline");

// Entry opened fullscreen from the sidebar? Collapse into the right-side
// panel so the conversation stays primary — the user's preferred form.
setMode("inline");
showHome();
