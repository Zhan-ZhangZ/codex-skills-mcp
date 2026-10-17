/* Lightweight MCP App controller. The transport supplies JSON-RPC only; this
 * controller owns the initialize handshake, navigation, detail explorer and
 * request lifecycle. */
import { createAppTransport } from "@openai/mcp-extensions/app/transport";

type SkillCard = { name: string; description: string; cached: boolean };
type Category = { name: string; skill_count: number };
type Listing = { view: "home" } | { view: "category"; category: string } | { view: "search"; query: string };
type View = Listing | { view: "detail"; skill: SkillCard; from: Listing };
type BrowseResult = {
  categories?: Category[]; totalSkills?: number; top?: SkillCard[]; skills?: SkillCard[];
  results?: SkillCard[]; total?: number; offset?: number; has_more?: boolean;
};
type HostContext = { theme?: string; styles?: { variables?: Record<string, string> } };
type ToolResult<T> = { structuredContent?: T; isError?: boolean; content?: { type: string; text?: string }[] };
type DetailTab = "instructions" | "files" | "sub_skills";
type NavigationView = Exclude<DetailTab, "instructions">;

type NavigationEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "sub_skill";
  description?: string;
  size_bytes?: number;
  text: string;
  excerpted: boolean;
};
type NavigationResult = {
  skill_name: string;
  view: NavigationView;
  path: string;
  query: string;
  total: number;
  matched: number;
  offset: number;
  returned: number;
  next_cursor: string | null;
  descriptions_excerpted: boolean;
  entries: NavigationEntry[];
};
type CacheSkill = {
  name: string;
  found: boolean;
  cached?: boolean;
  complete?: boolean;
  catalog_current?: boolean | null;
  local_path?: string;
  files_total?: number;
  files_missing_count?: number;
  files_missing_preview?: string[];
  size_bytes?: number;
  completed_at?: string | null;
};
type CacheResult = { requested: number; complete_count: number; truncated: boolean; skills: CacheSkill[] };
type FileReadResult = {
  content: string;
  size_bytes: number;
  offset: number;
  bytes_returned: number;
  next_offset?: number;
  has_more: boolean;
  binary: boolean;
};
type ExplorerState = {
  path: string;
  query: string;
  pages: NavigationResult[];
  index: number;
  loading: boolean;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing app element: ${id}`);
  return element as T;
};
const transport = createAppTransport();
const search = $<HTMLInputElement>("search");
const attach = $<HTMLButtonElement>("d-attach");
const navSearch = $<HTMLInputElement>("nav-search");
const previewMore = $<HTMLButtonElement>("preview-more");
const searchMore = $<HTMLButtonElement>("search-more");
const detailProgress = $<HTMLProgressElement>("d-progress");
const PROTOCOL_VERSION = "2026-01-26";
const DETAIL_PREVIEW_LIMIT = 200_000;
const EXPLORER_LIMIT = 50;
const FILE_PREVIEW_BYTES = 128 * 1024;
const FILE_PREVIEW_CHARS = 1_000_000;
let view: View = { view: "home" };
let revision = 0;
let disposed = false;
let connected = false;
let connecting = false;
let composing = false;
let attaching = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let navSearchTimer: ReturnType<typeof setTimeout> | undefined;
let navComposing = false;
let retry: (() => void) | undefined;
let detailTab: DetailTab = "instructions";
let explorerView: NavigationView = "files";
let explorerRequestRevision = 0;
let cacheStatusRevision = 0;
let previewRevision = 0;
let previewPath = "";
let previewText = "";
let previewNextOffset: number | undefined;
let currentSearch: BrowseResult | undefined;
let searchMoreLoading = false;
let detailProgressToken: string | undefined;

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

function emptyExplorer(): ExplorerState {
  return { path: "", query: "", pages: [], index: 0, loading: false };
}
let explorerStates: Record<NavigationView, ExplorerState> = {
  files: emptyExplorer(),
  sub_skills: emptyExplorer(),
};

function status(message: string, action?: () => void) {
  $("status").textContent = message;
  retry = action;
  $("retry").hidden = !action;
}
// Attachment feedback is independent of navigation/preview loading. Either
// request may finish first, and neither should erase the other's result.
function attachmentStatus(message: string) {
  $("d-attach-status").textContent = message;
  $("d-attach-status").hidden = !message;
}
function busy(value: boolean) {
  $("content").setAttribute("aria-busy", String(value));
}
function cancelNavigation() {
  clearTimeout(searchTimer);
  clearTimeout(navSearchTimer);
  searchTimer = undefined;
  navSearchTimer = undefined;
  // Transport requests cannot be aborted. Invalidate their UI effects immediately,
  // including during the debounce interval, and reuse any in-flight fetch later.
  revision++;
  explorerRequestRevision++;
  previewRevision++;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatBytes = (bytes = 0) => {
  if (bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};
const skillUri = (name: string) => `skill://${encodeURIComponent(name)}`;

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await transport.request<ToolResult<T>>("tools/call", { name, arguments: args }, 60_000);
  if (result?.isError) {
    throw new Error(result.content?.find((item) => item.type === "text")?.text || `工具 ${name} 调用失败`);
  }
  if (!result?.structuredContent) throw new Error("服务未返回结构化数据");
  return result.structuredContent;
}

async function readResourceText(uri: string, limit = 20_000, progressToken?: string): Promise<string> {
  const result = await transport.request<{ contents?: { text?: string }[] }>("resources/read", {
    uri,
    ...(progressToken ? { _meta: { progressToken } } : {}),
  }, 90_000);
  const text = result?.contents?.find((item) => typeof item.text === "string")?.text;
  if (typeof text !== "string") throw new Error("服务未返回文件文本");
  return text.length > limit ? text.slice(0, limit) + "\n…（界面预览已截断，完整文件已保存在技能缓存中）" : text;
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

function updateSearchMore() {
  const shown = currentSearch?.results?.length ?? 0;
  const total = currentSearch?.total ?? shown;
  searchMore.hidden = view.view !== "search" || !currentSearch?.has_more;
  searchMore.disabled = searchMoreLoading;
  searchMore.textContent = searchMoreLoading
    ? "正在加载…"
    : `加载更多搜索结果（${shown}/${total}）`;
}

function cacheBadge(state?: CacheSkill) {
  const badge = $("d-cached");
  const detail = $("d-cache-detail");
  const revisionNote = $("d-revision-note");
  badge.className = "badge";
  detail.textContent = "";
  revisionNote.hidden = true;
  if (!state || !state.found) {
    badge.textContent = state ? "技能不存在" : "检查缓存…";
    badge.className = "badge warn";
    return;
  }
  const count = state.files_total ?? 0;
  const size = formatBytes(state.size_bytes ?? 0);
  if (state.complete) {
    badge.textContent = "已完整缓存";
    badge.className = "badge on";
    detail.textContent = `${count} 个文件 · ${size} · 可执行`;
  } else if (state.cached && state.catalog_current === false) {
    badge.textContent = "缓存版本待验证";
    badge.className = "badge warn";
    detail.textContent = `${count} 个文件 · ${size} · 源版本检查失败`;
    revisionNote.textContent = "当前显示的是本地缓存版本；联网重试后才能确认它和源技能一致。";
    revisionNote.hidden = false;
  } else if (state.cached) {
    badge.textContent = "部分缓存";
    badge.className = "badge warn";
    detail.textContent = `缺少 ${state.files_missing_count ?? 0}/${count} 个文件`;
  } else {
    badge.textContent = "尚未缓存";
    detail.textContent = "读取说明时会下载完整技能";
  }
}

async function refreshCacheStatus(name: string, token: number) {
  const statusToken = ++cacheStatusRevision;
  try {
    const result = await call<CacheResult>("skill_status", { names: name });
    if (!disposed && revision === token && cacheStatusRevision === statusToken) {
      cacheBadge(result.skills.find((item) => item.name === name));
    }
  } catch {
    if (!disposed && revision === token && cacheStatusRevision === statusToken) {
      $("d-cache-detail").textContent = "缓存状态暂时不可用";
    }
  }
}

function markMaterialized() {
  cacheStatusRevision++;
  const badge = $("d-cached");
  badge.textContent = "已完整缓存";
  badge.className = "badge on";
  $("d-cache-detail").textContent = "正在读取文件统计…";
  $("d-revision-note").hidden = true;
  detailProgress.hidden = true;
}

function setTabs() {
  const tabs: Array<[DetailTab, string]> = [
    ["instructions", "tab-instructions"],
    ["files", "tab-files"],
    ["sub_skills", "tab-sub-skills"],
  ];
  for (const [tab, id] of tabs) {
    const selected = tab === detailTab;
    $(id).setAttribute("aria-selected", String(selected));
    $(id).setAttribute("tabindex", selected ? "0" : "-1");
  }
  $("instructions-pane").hidden = detailTab !== "instructions";
  $("explorer-pane").hidden = detailTab === "instructions";
  if (detailTab !== "instructions") {
    explorerView = detailTab;
    $("explorer-pane").setAttribute("aria-labelledby", detailTab === "files" ? "tab-files" : "tab-sub-skills");
    updateExplorerChrome();
  }
}

function clearExplorer() {
  explorerStates = { files: emptyExplorer(), sub_skills: emptyExplorer() };
  explorerRequestRevision++;
  closePreview();
  navSearch.value = "";
  $("nav-list").replaceChildren();
  $("nav-empty").hidden = true;
  $("nav-count").textContent = "";
  $("nav-page-info").textContent = "";
  $("nav-prev").hidden = true;
  $("nav-next").hidden = true;
}

function setDetailTab(tab: DetailTab, load = true) {
  if (detailTab === tab && load) {
    setTabs();
    return;
  }
  detailTab = tab;
  setTabs();
  if (tab === "instructions") {
    closePreview();
    return;
  }
  const state = explorerStates[tab];
  navSearch.value = state.query;
  renderBreadcrumb(state);
  if (state.pages.length) renderExplorerState(state);
  else if (load) void loadExplorer(true);
}

function updateExplorerChrome() {
  const subSkills = explorerView === "sub_skills";
  $("nav-search-label").textContent = subSkills ? "搜索全部子技能" : "搜索当前目录文件";
  navSearch.placeholder = subSkills ? "搜索子技能名称、路径或描述…" : "搜索文件名或路径…";
}

function renderBreadcrumb(state: ExplorerState) {
  const host = $("breadcrumb");
  const fragments: Node[] = [];
  const root = document.createElement("button");
  root.textContent = explorerView === "sub_skills" ? "全部子技能" : "技能根目录";
  root.onclick = () => changeExplorerPath("");
  fragments.push(root);
  let cursor = "";
  for (const part of state.path.split("/").filter(Boolean)) {
    const separator = document.createElement("span"); separator.textContent = "/";
    fragments.push(separator);
    cursor = cursor ? `${cursor}/${part}` : part;
    const target = cursor;
    const button = document.createElement("button");
    button.textContent = part;
    button.onclick = () => changeExplorerPath(target);
    fragments.push(button);
  }
  host.replaceChildren(...fragments);
}

function navigationCopy(entry: NavigationEntry): { name: string; description: string; size: string; icon: string } {
  if (entry.type === "directory") return { name: entry.name, description: entry.path, size: "", icon: "📁" };
  if (entry.type === "sub_skill") {
    return { name: entry.name, description: entry.description ? `${entry.path} · ${entry.description}` : entry.path, size: "", icon: "🧩" };
  }
  return { name: entry.name, description: entry.path, size: formatBytes(entry.size_bytes ?? 0), icon: "📄" };
}

function navigationRow(entry: NavigationEntry): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "nav-row";
  const copy = navigationCopy(entry);
  const icon = document.createElement("span"); icon.className = "nav-icon"; icon.textContent = copy.icon;
  const body = document.createElement("span"); body.className = "nav-copy";
  const name = document.createElement("span"); name.className = "nav-name"; name.textContent = copy.name;
  const description = document.createElement("span"); description.className = "nav-description"; description.textContent = copy.description;
  body.append(name, description);
  const size = document.createElement("span"); size.className = "nav-size"; size.textContent = copy.size;
  button.append(icon, body, size);
  if (entry.type === "directory") button.onclick = () => changeExplorerPath(entry.path);
  else if (entry.type === "sub_skill") button.onclick = () => void openFile(`${entry.path}/SKILL.md`);
  else button.onclick = () => void openFile(entry.path);
  return button;
}

function renderExplorerState(state: ExplorerState) {
  const page = state.pages[state.index];
  const list = $("nav-list");
  const empty = $("nav-empty");
  if (!page) {
    list.replaceChildren();
    empty.textContent = "还没有可显示的内容。";
    empty.hidden = false;
    $("nav-count").textContent = "";
    $("nav-page-info").textContent = "";
    $("nav-prev").hidden = true;
    $("nav-next").hidden = true;
    return;
  }
  list.replaceChildren(...page.entries.map(navigationRow));
  const label = explorerView === "sub_skills" ? "个子技能" : "个文件项";
  $("nav-count").textContent = `${page.matched} ${label}`;
  empty.hidden = page.entries.length !== 0;
  empty.textContent = page.query
    ? `没有找到匹配“${page.query}”的内容。`
    : explorerView === "sub_skills" ? "这个技能没有嵌套子技能。" : "这个目录没有可显示的文件。";
  const first = page.returned ? page.offset + 1 : 0;
  const last = page.offset + page.returned;
  $("nav-page-info").textContent = page.matched
    ? `${first}–${last} / 共 ${page.matched} 项`
    : "0 项";
  $("nav-prev").hidden = state.index === 0;
  $("nav-next").hidden = !page.next_cursor;
}

function showExplorerLoading() {
  $("nav-list").replaceChildren();
  const empty = $("nav-empty");
  empty.textContent = "正在读取技能目录…";
  empty.hidden = false;
  $("nav-page-info").textContent = "加载中…";
  $("nav-prev").hidden = true;
  $("nav-next").hidden = true;
}

async function loadExplorer(reset: boolean) {
  if (view.view !== "detail" || detailTab === "instructions") return;
  const selected = view;
  const state = explorerStates[detailTab];
  if (!reset && state.loading) return;
  if (reset) {
    state.pages = [];
    state.index = 0;
  }
  const cursor = reset ? undefined : state.pages.at(-1)?.next_cursor ?? undefined;
  if (!reset && !cursor) return;
  const token = ++explorerRequestRevision;
  const selectedTab = detailTab;
  // A response may only render for the same detail, tab and request generation.
  const sameView = () => !disposed && view === selected && detailTab === selectedTab &&
    explorerView === selectedTab && explorerRequestRevision === token;
  state.loading = true;
  showExplorerLoading();
  try {
    const result = await call<NavigationResult>("list_skill_files", {
      skill_name: selected.skill.name,
      view: selectedTab,
      path: state.path,
      query: state.query,
      limit: EXPLORER_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!sameView()) return;
    if (reset) state.pages = [result];
    else state.pages.push(result);
    state.index = state.pages.length - 1;
    renderExplorerState(state);
  } catch (error) {
    if (!sameView()) return;
    if (!reset && state.pages.length > 1) state.pages.pop();
    state.index = Math.max(0, state.pages.length - 1);
    renderExplorerState(state);
    $("nav-empty").textContent = `目录读取失败：${errorMessage(error)}`;
    $("nav-empty").hidden = false;
  } finally {
    if (sameView()) state.loading = false;
  }
}

function changeExplorerPath(path: string) {
  const state = explorerStates[explorerView];
  state.path = path;
  state.query = "";
  state.pages = [];
  state.index = 0;
  navSearch.value = "";
  closePreview();
  renderBreadcrumb(state);
  void loadExplorer(true);
}

function scheduleExplorerSearch(immediate = false) {
  if (navComposing || view.view !== "detail" || detailTab === "instructions") return;
  clearTimeout(navSearchTimer);
  const state = explorerStates[explorerView];
  state.query = navSearch.value.trim();
  state.pages = [];
  state.index = 0;
  const run = () => void loadExplorer(true);
  if (immediate) run();
  else {
    showExplorerLoading();
    navSearchTimer = setTimeout(run, 250);
  }
}

async function openFile(path: string) {
  if (view.view !== "detail" || !path) return;
  previewPath = path;
  previewText = "";
  previewNextOffset = undefined;
  $("preview-path").textContent = path;
  $("preview-content").textContent = "正在读取文件…";
  previewMore.hidden = true;
  $("file-preview").hidden = false;
  $("file-preview").scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  await loadFileChunk(path, 0, false);
}

async function loadFileChunk(path: string, offset: number, append: boolean) {
  if (view.view !== "detail" || !path) return;
  const selected = view;
  const token = ++previewRevision;
  previewMore.disabled = true;
  if (append) previewMore.hidden = true;
  try {
    const result = await call<FileReadResult>("load_skill_file", {
      skill_name: selected.skill.name,
      file_path: path,
      offset,
      max_bytes: FILE_PREVIEW_BYTES,
    });
    if (disposed || view !== selected || previewRevision !== token) return;
    const combined = (append ? previewText : "") + result.content;
    const limited = combined.length > FILE_PREVIEW_CHARS;
    previewText = limited ? combined.slice(0, FILE_PREVIEW_CHARS) + "\n…（界面预览已达到 1M 字符上限）" : combined;
    previewNextOffset = limited ? undefined : result.next_offset;
    $("preview-content").textContent = previewText;
    previewMore.hidden = !previewNextOffset;
  } catch (error) {
    if (disposed || view !== selected || previewRevision !== token) return;
    if (append) $("preview-content").textContent = previewText + `\n\n读取下一段失败：${errorMessage(error)}`;
    else $("preview-content").textContent = `读取失败：${errorMessage(error)}`;
    previewMore.hidden = previewNextOffset === undefined;
  } finally {
    if (!disposed && view === selected && previewRevision === token) previewMore.disabled = false;
  }
}

function closePreview() {
  previewRevision++;
  previewPath = "";
  previewText = "";
  previewNextOffset = undefined;
  $("file-preview").hidden = true;
  $("preview-content").textContent = "";
  $("preview-path").textContent = "";
  previewMore.hidden = true;
}

function showView(next: View) {
  const previous = view;
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
    if (previous !== next) attachmentStatus("");
    cacheStatusRevision++;
    cacheBadge();
    $("d-md").textContent = "正在下载并读取完整技能…";
    $("d-cache-detail").textContent = "";
    detailProgress.hidden = true;
    attach.disabled = attaching;
    clearExplorer();
    setDetailTab("instructions", false);
  } else if (next.view === "home") {
    currentSearch = undefined;
    $("cards").replaceChildren();
    $("cats").replaceChildren();
  } else {
    if (next.view === "search") currentSearch = undefined;
    $("cards-list").replaceChildren();
  }
  searchMore.hidden = true;
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
      void refreshCacheStatus(next.skill.name, token);
      // Always re-read through the resource so source updates can replace a
      // previous cache. A complete local cache makes this an inexpensive read.
      detailProgressToken = `skill-${next.skill.name}-${token}`;
      const text = await readResourceText(skillUri(next.skill.name), DETAIL_PREVIEW_LIMIT, detailProgressToken);
      // Materialization succeeded even if the user has already navigated away.
      next.skill.cached = true;
      if (!current()) return;
      $("d-md").textContent = text;
      markMaterialized();
      status("说明已加载；可切换文件或子技能继续查看");
      void refreshCacheStatus(next.skill.name, token);
    } else {
      const data = await cached(JSON.stringify(next), () => next.view === "search"
        ? call<BrowseResult>("skills.query", { query: next.query, limit: 24 })
        : call<BrowseResult>("skills.browse", next.view === "category" ? { category: next.category } : {}));
      if (!current()) return;
      if (next.view === "home") {
        $("count").textContent = `${data.totalSkills ?? 0} 技能`;
        renderCards($("cards"), data.top ?? []);
        renderCategories(data.categories ?? []);
        status(data.totalSkills ? "选择分类或搜索技能" : "技能库为空，请检查服务端技能源配置");
      } else {
        const skills = (next.view === "search" ? data.results : data.skills) ?? [];
        if (next.view === "search") {
          currentSearch = data;
          $("count").textContent = `${skills.length}/${data.total ?? skills.length} 结果`;
        } else {
          $("count").textContent = `${skills.length} 个`;
        }
        renderCards($("cards-list"), skills);
        $("empty").hidden = skills.length !== 0;
        $("empty").textContent = next.view === "search" ? "没有找到匹配技能，试试更短的关键词或描述要完成的任务。" : "该分类暂无技能。";
        status(skills.length ? "选择技能查看详情" : "没有匹配结果");
        if (next.view === "search") updateSearchMore();
      }
    }
  } catch (error) {
    if (!current()) return;
    if (next.view === "detail") {
      $("d-md").textContent = "读取未完成。技能可能仍在后台下载，重试可继续获取内容。";
      detailProgress.hidden = true;
      void refreshCacheStatus(next.skill.name, token);
    }
    status(`加载失败：${errorMessage(error)}`, () => void navigate(next));
  } finally {
    if (current()) busy(false);
  }
}

attach.onclick = async () => {
  if (view.view !== "detail" || attaching || !connected) return;
  const selected = view;
  const skill = selected.skill;
  attaching = true; attach.disabled = true;
  attachmentStatus(`正在将「${skill.name}」加入对话…`);
  try {
    const result = await transport.request<{ isError?: boolean }>("ui/update-model-context", {
      content: [{ type: "text", text: `已选择技能：${skill.name}。通过 resources/read 读取 ${skillUri(skill.name)} 获取完整使用说明。` }],
      structuredContent: { skill: { name: skill.name, uri: skillUri(skill.name) } },
    }, 15_000);
    if (result?.isError) throw new Error("宿主未接受技能上下文");
    if (view === selected && !disposed) attachmentStatus(`已将「${skill.name}」加入对话上下文`);
  } catch (error) {
    if (view === selected && !disposed) attachmentStatus(`加入失败：${errorMessage(error)}`);
  } finally {
    attaching = false; attach.disabled = !connected;
  }
};

$("back").onclick = () => void navigate(view.view === "detail" ? view.from : { view: "home" });
$("retry").onclick = () => retry?.();
searchMore.onclick = async () => {
  if (view.view !== "search" || !currentSearch || searchMoreLoading) return;
  const selected = view;
  const token = revision;
  const offset = currentSearch.results?.length ?? 0;
  searchMoreLoading = true;
  updateSearchMore();
  try {
    const page = await call<BrowseResult>("skills.query", {
      query: selected.query,
      limit: 24,
      offset,
    });
    if (disposed || revision !== token || view !== selected) return;
    const merged: BrowseResult = {
      ...currentSearch,
      ...page,
      results: [...(currentSearch.results ?? []), ...(page.results ?? [])],
      offset: 0,
    };
    merged.has_more = (merged.results?.length ?? 0) < (merged.total ?? 0);
    currentSearch = merged;
    cache.set(JSON.stringify(selected), { value: merged, expires: Date.now() + 30_000 });
    renderCards($("cards-list"), merged.results ?? []);
    $("count").textContent = `${merged.results?.length ?? 0}/${merged.total ?? 0} 结果`;
    status(`已加载 ${merged.results?.length ?? 0}/${merged.total ?? 0} 个搜索结果`);
  } catch (error) {
    if (!disposed && revision === token && view === selected) {
      status(`加载更多失败：${errorMessage(error)}`, () => searchMore.click());
    }
  } finally {
    if (!disposed) {
      searchMoreLoading = false;
      if (view === selected) updateSearchMore();
    }
  }
};
$("tab-instructions").onclick = () => setDetailTab("instructions");
$("tab-files").onclick = () => setDetailTab("files");
$("tab-sub-skills").onclick = () => setDetailTab("sub_skills");
$("tab-instructions").addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") { event.preventDefault(); setDetailTab("files"); $("tab-files").focus(); }
});
$("tab-files").addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") { event.preventDefault(); setDetailTab("sub_skills"); $("tab-sub-skills").focus(); }
  if (event.key === "ArrowLeft") { event.preventDefault(); setDetailTab("instructions"); $("tab-instructions").focus(); }
});
$("tab-sub-skills").addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") { event.preventDefault(); setDetailTab("files"); $("tab-files").focus(); }
});
$("nav-prev").onclick = () => {
  const state = explorerStates[explorerView];
  if (state.index <= 0) return;
  state.index--;
  closePreview();
  renderExplorerState(state);
};
$("nav-next").onclick = () => {
  const state = explorerStates[explorerView];
  if (state.index + 1 < state.pages.length) {
    state.index++;
    closePreview();
    renderExplorerState(state);
  } else void loadExplorer(false);
};
$("preview-close").onclick = closePreview;
previewMore.onclick = () => {
  if (previewPath && previewNextOffset !== undefined) void loadFileChunk(previewPath, previewNextOffset, true);
};
$("preview-copy").onclick = () => {
  if (!previewPath) return;
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) { $("status").textContent = `文件路径：${previewPath}`; return; }
  void clipboard.writeText(previewPath).then(
    () => { $("status").textContent = "文件路径已复制"; },
    (error) => { $("status").textContent = `复制失败：${errorMessage(error)}`; },
  );
};
navSearch.addEventListener("input", () => scheduleExplorerSearch());
navSearch.addEventListener("compositionstart", () => { navComposing = true; clearTimeout(navSearchTimer); });
navSearch.addEventListener("compositionend", () => { navComposing = false; scheduleExplorerSearch(); });
navSearch.addEventListener("keydown", (event) => {
  if (event.isComposing || navComposing) return;
  if (event.key === "Enter") { event.preventDefault(); scheduleExplorerSearch(true); }
  if (event.key === "Escape") { navSearch.value = ""; scheduleExplorerSearch(true); }
});

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
transport.on("notifications/progress", (params: {
  progressToken?: string | number; progress?: number; total?: number; message?: string;
}) => {
  if (disposed || view.view !== "detail" || String(params.progressToken) !== detailProgressToken) return;
  const total = Math.max(1, Number(params.total) || 1);
  const done = Math.max(0, Math.min(total, Number(params.progress) || 0));
  detailProgress.max = total;
  detailProgress.value = done;
  detailProgress.hidden = false;
  $("d-cache-detail").textContent = params.message || `正在下载 ${done}/${total} 个文件`;
});
transport.handle("ping", () => ({}));
function dispose() {
  disposed = true; cancelNavigation();
  cache.clear(); pending.clear();
  explorerStates = { files: emptyExplorer(), sub_skills: emptyExplorer() };
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
