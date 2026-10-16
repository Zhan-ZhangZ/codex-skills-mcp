/* Lightweight MCP App controller. The transport supplies JSON-RPC only; this
 * controller owns the initialize handshake, navigation and request lifecycle. */
import { createAppTransport } from "@openai/mcp-extensions/app/transport";

type SkillCard = { name: string; description: string; cached: boolean };
type Category = { name: string; skill_count: number };
type Listing = { view: "home" } | { view: "category"; category: string } | { view: "search"; query: string };
type View = Listing | { view: "detail"; skill: SkillCard; from: Listing };
type BrowseResult = { categories?: Category[]; totalSkills?: number; top?: SkillCard[]; skills?: SkillCard[]; results?: SkillCard[] };
type HostContext = { theme?: string; styles?: { variables?: Record<string, string> } };
type ToolResult = { structuredContent?: BrowseResult; isError?: boolean; content?: { type: string; text?: string }[] };

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing app element: ${id}`);
  return element as T;
};
const transport = createAppTransport();
const search = $<HTMLInputElement>("search");
const attach = $<HTMLButtonElement>("d-attach");
const PROTOCOL_VERSION = "2026-01-26";
let view: View = { view: "home" };
let revision = 0;
let disposed = false;
let connected = false;
let connecting = false;
let composing = false;
let attaching = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let retry: (() => void) | undefined;

// Keep navigation instant without allowing unbounded query or document caches.
const cache = new Map<string, { value: BrowseResult | string; expires: number }>();
const pending = new Map<string, Promise<BrowseResult | string>>();
async function cached<T extends BrowseResult | string>(key: string, load: () => Promise<T>, ttl = 30_000): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const active = pending.get(key);
  if (active) return active as Promise<T>;
  const request = load().then((value) => {
    cache.delete(key);
    cache.set(key, { value, expires: Date.now() + ttl });
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

function status(message: string, action?: () => void) {
  $("status").textContent = message;
  retry = action;
  $("retry").hidden = !action;
}
function busy(value: boolean) {
  $("content").setAttribute("aria-busy", String(value));
}
function cancelNavigation() {
  clearTimeout(searchTimer);
  searchTimer = undefined;
  // Transport requests cannot be aborted. Invalidate their UI effects immediately,
  // including during the debounce interval, and reuse any in-flight fetch later.
  revision++;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function call(name: string, args: Record<string, unknown>): Promise<BrowseResult> {
  const result = await transport.request<ToolResult>("tools/call", { name, arguments: args }, 30_000);
  if (result?.isError) {
    throw new Error(result.content?.find((item) => item.type === "text")?.text || `工具 ${name} 调用失败`);
  }
  if (!result?.structuredContent) throw new Error("服务未返回技能数据");
  return result.structuredContent;
}

async function readSkillMd(name: string): Promise<string> {
  const result = await transport.request<{ contents?: { text?: string }[] }>(
    "resources/read", { uri: `skill://${encodeURIComponent(name)}` }, 60_000
  );
  const text = result?.contents?.find((item) => typeof item.text === "string")?.text;
  if (typeof text !== "string") throw new Error("服务未返回 SKILL.md 文本");
  return text.length > 12_000 ? text.slice(0, 12_000) + "\n…（预览已截断，加入对话后可读取完整内容）" : text;
}

function card(skill: SkillCard): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "card";
  const title = document.createElement("b"); title.textContent = skill.name;
  const description = document.createElement("p"); description.textContent = skill.description;
  const badge = document.createElement("span");
  badge.className = "badge" + (skill.cached ? " on" : "");
  badge.textContent = skill.cached ? "已缓存" : "按需下载";
  button.append(title, description, badge);
  button.onclick = () => {
    if (view.view !== "detail") void navigate({ view: "detail", skill, from: view });
  };
  return button;
}
function renderCards(host: HTMLElement, skills: SkillCard[]) {
  host.replaceChildren(...skills.map(card));
}
function renderCategories(categories: Category[]) {
  $("cats").replaceChildren(...categories.map((category) => {
    const button = document.createElement("button"); button.className = "cat";
    const name = document.createElement("b"); name.textContent = category.name;
    const count = document.createElement("span"); count.className = "muted";
    count.textContent = `${category.skill_count} 个`;
    button.append(name, count);
    button.onclick = () => void navigate({ view: "category", category: category.name });
    return button;
  }));
}
function cachedBadge(cached: boolean) {
  $("d-cached").textContent = cached ? "已缓存" : "按需下载";
  $("d-cached").className = "badge" + (cached ? " on" : "");
}
function showView(next: View) {
  view = next;
  $("home").hidden = next.view !== "home";
  $("list").hidden = next.view !== "category" && next.view !== "search";
  $("detail").hidden = next.view !== "detail";
  $("back").hidden = next.view === "home";
  $("heading").textContent = next.view === "category" ? next.category :
    next.view === "search" ? `搜索“${next.query}”` :
    next.view === "detail" ? next.skill.name : "Codex Skills 技能库";
  $("count").textContent = "";
  $("empty").hidden = true;
  if (next.view !== "detail") search.value = next.view === "search" ? next.query : "";
  if (next.view === "detail") {
    cachedBadge(next.skill.cached);
    $("d-md").textContent = "正在读取 SKILL.md…";
    attach.disabled = attaching;
  } else if (next.view === "home") {
    $("cards").replaceChildren();
    $("cats").replaceChildren();
  } else {
    $("cards-list").replaceChildren();
  }
  if (document.activeElement?.tagName === "BUTTON") $("heading").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function navigate(next: View) {
  cancelNavigation();
  const token = revision;
  const current = () => !disposed && revision === token;
  showView(next);
  busy(true);
  status(next.view === "search" ? "搜索中…" : "加载中…");
  try {
    if (next.view === "detail") {
      const text = await cached(`detail:${next.skill.name}`, () => readSkillMd(next.skill.name), 300_000);
      // Materialization succeeded even if the user has already navigated away.
      next.skill.cached = true;
      for (const [key] of cache) if (!key.startsWith("detail:")) cache.delete(key);
      if (!current()) return;
      $("d-md").textContent = text;
      cachedBadge(true);
      status("技能已就绪，可加入对话");
    } else {
      const data = await cached(JSON.stringify(next), () => next.view === "search"
        ? call("skills.query", { query: next.query, limit: 24 })
        : call("skills.browse", next.view === "category" ? { category: next.category } : {}));
      if (!current()) return;
      if (next.view === "home") {
        $("count").textContent = `${data.totalSkills ?? 0} 技能`;
        renderCards($("cards"), data.top ?? []);
        renderCategories(data.categories ?? []);
        status(data.totalSkills ? "选择分类或搜索技能" : "技能库为空，请检查服务端技能源配置");
      } else {
        const skills = (next.view === "search" ? data.results : data.skills) ?? [];
        $("count").textContent = `${skills.length} ${next.view === "search" ? "结果" : "个"}`;
        renderCards($("cards-list"), skills);
        $("empty").hidden = skills.length !== 0;
        $("empty").textContent = next.view === "search" ? "没有找到匹配技能，试试更短的关键词或描述要完成的任务。" : "该分类暂无技能。";
        status(skills.length ? "选择技能查看详情" : "没有匹配结果");
      }
    }
  } catch (error) {
    if (!current()) return;
    if (next.view === "detail") $("d-md").textContent = "读取未完成。重试可继续获取技能内容。";
    status(`加载失败：${errorMessage(error)}`, () => void navigate(next));
  } finally {
    if (current()) busy(false);
  }
}

attach.onclick = async () => {
  if (view.view !== "detail" || attaching || !connected) return;
  const skill = view.skill;
  const token = revision;
  attaching = true; attach.disabled = true;
  try {
    const result = await transport.request<{ isError?: boolean }>("ui/update-model-context", {
      content: [{ type: "text", text: `已选择技能：${skill.name}。通过 resources/read 读取 skill://${encodeURIComponent(skill.name)} 获取完整使用说明。` }],
      structuredContent: { skill: { name: skill.name, uri: `skill://${encodeURIComponent(skill.name)}` } },
    }, 15_000);
    if (result?.isError) throw new Error("宿主未接受技能上下文");
    if (revision === token && !disposed) status(`已将「${skill.name}」加入对话上下文`);
  } catch (error) {
    if (revision === token && !disposed) status(`加入失败：${errorMessage(error)}`);
  } finally {
    attaching = false; attach.disabled = !connected;
  }
};
$("back").onclick = () => void navigate(view.view === "detail" ? view.from : { view: "home" });
$("retry").onclick = () => retry?.();

function scheduleSearch(immediate = false) {
  if (!connected || composing) return;
  cancelNavigation();
  const query = search.value.trim();
  if (!query) { void navigate({ view: "home" }); return; }
  const run = () => void navigate({ view: "search", query });
  if (immediate) run();
  else { busy(true); status("等待输入…"); searchTimer = setTimeout(run, 250); }
}
search.addEventListener("input", () => scheduleSearch());
search.addEventListener("compositionstart", () => { composing = true; cancelNavigation(); });
search.addEventListener("compositionend", () => { composing = false; scheduleSearch(); });
search.addEventListener("keydown", (event) => {
  if (event.isComposing || composing) return;
  if (event.key === "Enter") { event.preventDefault(); scheduleSearch(true); }
  if (event.key === "Escape") { search.value = ""; scheduleSearch(true); }
});

function applyHostContext(context: HostContext) {
  if (context.theme === "light" || context.theme === "dark") {
    document.documentElement.dataset.theme = context.theme;
    document.documentElement.style.colorScheme = context.theme;
  }
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (name.startsWith("--") && typeof value === "string") document.documentElement.style.setProperty(name, value);
  }
}
transport.on("ui/notifications/host-context-changed", applyHostContext);
transport.handle("ping", () => ({}));
function dispose() {
  disposed = true; cancelNavigation();
  cache.clear(); pending.clear();
  transport.dispose();
}
transport.handle("ui/resource-teardown", () => { setTimeout(dispose, 0); return {}; });
window.addEventListener("pagehide", dispose, { once: true });

async function connect() {
  if (connecting || disposed) return;
  connecting = true; busy(true); search.disabled = true;
  status("正在连接技能库…");
  try {
    const result = await transport.request<{ protocolVersion: string; hostContext?: HostContext }>("ui/initialize", {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: { name: "codex-skills", version: __APP_VERSION__ },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    if (disposed) return;
    if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error(`不支持的界面协议：${result.protocolVersion}`);
    applyHostContext(result.hostContext ?? {});
    transport.notify("ui/notifications/initialized");
    connected = true; search.disabled = false;
    await navigate({ view: "home" });
  } catch (error) {
    if (!disposed) { busy(false); status(`连接失败：${errorMessage(error)}`, () => void connect()); }
  } finally { connecting = false; }
}

declare const __APP_VERSION__: string;
void connect();
