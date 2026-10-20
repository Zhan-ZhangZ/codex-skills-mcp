/* Lightweight MCP App controller. The transport supplies JSON-RPC only; this
 * controller owns the initialize handshake, navigation, detail explorer and
 * request lifecycle. */
import { createAppTransport } from "@openai/mcp-extensions/app/transport";
import DOMPurify from "dompurify";
import { marked } from "marked";

type SkillCard = {
  name: string;
  description: string;
  cached: boolean;
  category?: string;
  size_bytes?: number;
  updated_at?: string;
  confidence?: number;
  confidence_label?: "high" | "medium" | "low";
  match_reasons?: string[];
  matched_terms?: string[];
  match_mode?: "keyword" | "task";
  reads?: number;
  failures?: number;
  last_used_at?: number | null;
};
type Category = { name: string; skill_count: number };
type Listing = { view: "home" } | { view: "category"; category: string } | { view: "search"; query: string };
type View = Listing | { view: "detail"; skill: SkillCard; from: Listing };
type BrowseResult = {
  categories?: Category[]; totalSkills?: number; top?: SkillCard[]; skills?: SkillCard[];
  results?: SkillCard[]; total?: number; offset?: number; has_more?: boolean;
  butler?: string | null;
  cache_mode?: "remote" | "local";
  usage?: { total_reads: number; used_skills: number; total_failures: number };
};
type HostModelContext = {
  content?: Record<string, unknown>[];
  structuredContent?: Record<string, unknown>;
  updateId?: string;
};
type HostContext = {
  theme?: string;
  styles?: { variables?: Record<string, string> };
  "openai/modelContext"?: HostModelContext | null;
};
type HostCapabilities = {
  updateModelContext?: {
    text?: unknown;
    resource?: unknown;
    resourceLink?: unknown;
    structuredContent?: unknown;
  };
};
type InitializeResult = {
  protocolVersion: string;
  hostContext?: HostContext;
  hostCapabilities?: HostCapabilities;
};
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
  root?: boolean;
  cacheable?: boolean;
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
type DownloadProgress = {
  name: string; done: number; total: number; message: string; updated_at: number; active: boolean;
};
type ClearCacheResult = {
  name: string;
  found: boolean;
  cleared: boolean;
  local_path: string;
  files_removed: number;
  bytes_removed: number;
  cache_mode: "remote" | "local";
};
type FileReadResult = {
  content: string;
  size_bytes: number;
  offset: number;
  bytes_returned: number;
  next_offset?: number;
  has_more: boolean;
  binary: boolean;
  mime_type?: string;
};
type ImagePreviewResult = {
  mime_type: string;
  size_bytes: number;
  data_base64: string;
};
type ResourceReadResult = {
  text: string;
  meta: Record<string, unknown>;
};
type LegacySearchEntry = string | { query?: unknown; at?: unknown };
type ExplorerState = {
  path: string;
  query: string;
  pages: NavigationResult[];
  index: number;
  loading: boolean;
};
type SearchHistoryEntry = { query: string; at: number };
type SearchHistoryResult = { entries: SearchHistoryEntry[] };
type AttachedSkill = {
  name: string;
  uri: string;
  description?: string;
  category?: string;
  local_path?: string | null;
  instruction_chars?: number;
};
type ModelContextUpdateResult = {
  isError?: boolean;
  _meta?: { "openai/modelContext"?: { updateId?: string } };
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing app element: ${id}`);
  return element as T;
};
const transport = createAppTransport();
const search = $<HTMLInputElement>("search");
const searchHistoryPanel = $<HTMLDivElement>("search-history");
const searchHistoryList = $<HTMLDivElement>("search-history-list");
const searchHistoryCount = $<HTMLElement>("search-history-count");
const searchHistoryMore = $<HTMLButtonElement>("search-history-more");
const searchHistoryClear = $<HTMLButtonElement>("search-history-clear");
const attachedBar = $<HTMLElement>("attached-bar");
const attachedSummary = $<HTMLElement>("attached-summary");
const attachedList = $<HTMLDivElement>("attached-list");
const attachedClear = $<HTMLButtonElement>("attached-clear");
const attach = $<HTMLButtonElement>("d-attach");
const clearCacheButton = $<HTMLButtonElement>("d-clear-cache");
const detailFlow = $<HTMLElement>("detail-flow");
const navSearch = $<HTMLInputElement>("nav-search");
const previewMore = $<HTMLButtonElement>("preview-more");
const previewOpenHost = $<HTMLButtonElement>("preview-open-host");
const previewContent = $<HTMLPreElement>("preview-content");
const previewImageWrap = $<HTMLDivElement>("preview-image-wrap");
const previewImage = $<HTMLImageElement>("preview-image");
const previewMediaMeta = $<HTMLElement>("preview-media-meta");
const searchMore = $<HTMLButtonElement>("search-more");
const detailProgress = $<HTMLDivElement>("d-progress");
const progressFill = $<HTMLDivElement>("d-progress-fill");
const progressPercent = $<HTMLElement>("d-progress-percent");
const progressMeta = $<HTMLElement>("d-progress-meta");
const suggestModal = $<HTMLDivElement>("suggest-modal");
const suggestEmail = "sidian1025@163.com";
const renderedInstructions = $<HTMLDivElement>("d-md-rendered");
const instructionRaw = $<HTMLPreElement>("d-md");
const instructionToggle = $<HTMLButtonElement>("doc-toggle");
const documentSource = $<HTMLElement>("doc-source");
const previewCopyButton = $<HTMLButtonElement>("preview-copy");
const PROTOCOL_VERSION = "2026-01-26";
const LEGACY_SEARCH_HISTORY_KEY = "codex-skills.search-history.v1";
const SEARCH_HISTORY_LIMIT = 8;
const SEARCH_HISTORY_VISIBLE_LIMIT = 6;
const SEARCH_HISTORY_LABEL_MAX = 56;
const HANDOFF_BLOCK_META = "codex-skills/skill";
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
let searchBlurTimer: ReturnType<typeof setTimeout> | undefined;
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
let previewCopyPath = "";
let detailLocalPath = "";
let detailInstructions = "";
let currentSearch: BrowseResult | undefined;
let searchMoreLoading = false;
let detailProgressToken: string | undefined;
let progressPollTimer: ReturnType<typeof setInterval> | undefined;
let progressPollLoading = false;
let instructionMode: "rendered" | "raw" = "rendered";
let cacheMode: "remote" | "local" | undefined;
let clearCacheBusy = false;
let clearCacheArmed = false;
let clearCacheTimer: ReturnType<typeof setTimeout> | undefined;
let detailMaterializing = false;
let lastCacheState: CacheSkill | undefined;
let butlerName = "00_codex_skills";
let suggestReturnFocus: HTMLElement | null = null;
let hostCapabilities: HostCapabilities | undefined;
let hostModelContext: HostModelContext | null = null;
let searchHistory: SearchHistoryEntry[] = [];
let searchHistoryExpanded = false;
let searchFocused = false;
let historyServerQueue: Promise<void> = Promise.resolve();
let historyRequestRevision = 0;
suggestModal.hidden = true;

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

function normalizeHistory(entries: SearchHistoryEntry[]): SearchHistoryEntry[] {
  const seen = new Set<string>();
  return entries
    .map((entry) => ({
      query: typeof entry?.query === "string" ? entry.query.trim().slice(0, 500) : "",
      at: Number.isFinite(entry?.at) ? entry.at : 0,
    }))
    .filter((entry) => entry.query.length > 0)
    .sort((a, b) => b.at - a.at)
    .filter((entry) => {
      const key = entry.query.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, SEARCH_HISTORY_LIMIT);
}

function readLegacySearchHistory(): SearchHistoryEntry[] {
  try {
    const raw = window.localStorage?.getItem(LEGACY_SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeHistory(parsed.flatMap((item: LegacySearchEntry): SearchHistoryEntry[] => {
      const query = typeof item === "string"
        ? item.trim()
        : item && typeof item === "object" && typeof item.query === "string"
          ? item.query.trim()
          : "";
      if (!query) return [];
      const at = item && typeof item === "object" &&
        typeof item.at === "number" && Number.isFinite(item.at)
        ? item.at
        : 0;
      return [{ query, at }];
    }));
  } catch {
    return [];
  }
}

function removeLegacySearchHistory(): void {
  try {
    window.localStorage?.removeItem(LEGACY_SEARCH_HISTORY_KEY);
  } catch {
    // A restricted host can keep the legacy copy; migration stays idempotent.
  }
}

function adoptSharedHistory(entries: SearchHistoryEntry[]): void {
  searchHistory = normalizeHistory(entries);
  if (searchHistory.length <= SEARCH_HISTORY_VISIBLE_LIMIT) searchHistoryExpanded = false;
  renderSearchHistory();
}

function queueHistoryRequest(
  request: () => Promise<SearchHistoryResult>,
): Promise<boolean> {
  const revision = ++historyRequestRevision;
  let succeeded = false;
  historyServerQueue = historyServerQueue.catch(() => {}).then(async () => {
    try {
      const result = await request();
      succeeded = true;
      if (disposed || revision !== historyRequestRevision) return;
      adoptSharedHistory(result.entries ?? []);
    } catch {
      // Keep the optimistic in-memory list when the shared store is offline.
    }
  });
  return historyServerQueue.then(() => succeeded);
}

function refreshSharedSearchHistory(): Promise<boolean> {
  if (!connected) return Promise.resolve(false);
  return queueHistoryRequest(() => call<SearchHistoryResult>("skills.getSearchHistory", {}));
}

async function migrateLegacySearchHistory(): Promise<void> {
  const legacy = readLegacySearchHistory();
  if (legacy.length === 0) return;
  // Replay oldest to newest so the shared store can merge incremental typing.
  // A failed import keeps the legacy copy, and every replay is idempotent.
  for (const entry of [...legacy].sort((a, b) => a.at - b.at)) {
    const recorded = await queueHistoryRequest(() => call<SearchHistoryResult>("skills.recordSearch", {
      query: entry.query,
      at: entry.at,
    }));
    if (!recorded) return;
  }
  removeLegacySearchHistory();
}

function searchHistoryLabel(query: string): string {
  const characters = Array.from(query);
  return characters.length > SEARCH_HISTORY_LABEL_MAX
    ? characters.slice(0, SEARCH_HISTORY_LABEL_MAX - 1).join("").trimEnd() + "…"
    : query;
}

function syncSearchHistoryVisibility(): void {
  const active = document.activeElement;
  const panelFocused = !!active &&
    typeof searchHistoryPanel.contains === "function" &&
    searchHistoryPanel.contains(active);
  const visible = searchHistory.length > 0 && view.view !== "detail" &&
    !search.value.trim() && (searchFocused || panelFocused);
  searchHistoryPanel.hidden = !visible;
}

function renderSearchHistory(): void {
  const visibleHistory = searchHistoryExpanded
    ? searchHistory
    : searchHistory.slice(0, SEARCH_HISTORY_VISIBLE_LIMIT);
  searchHistoryList.replaceChildren(...visibleHistory.map((entry, index) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "history-chip";
    chip.textContent = searchHistoryLabel(entry.query);
    chip.title = entry.query;
    chip.setAttribute("aria-label", `再次搜索：${entry.query}`);
    chip.style.animationDelay = `${Math.min(index, 5) * 28}ms`;
    chip.addEventListener("click", () => {
      search.value = entry.query;
      void navigate({ view: "search", query: entry.query });
    });
    return chip;
  }));
  searchHistoryCount.textContent = String(searchHistory.length);
  const hiddenCount = Math.max(0, searchHistory.length - SEARCH_HISTORY_VISIBLE_LIMIT);
  searchHistoryMore.hidden = hiddenCount === 0;
  searchHistoryMore.textContent = searchHistoryExpanded ? "收起" : `更多 ${hiddenCount}`;
  searchHistoryMore.setAttribute("aria-expanded", String(searchHistoryExpanded));
  syncSearchHistoryVisibility();
}

function rememberSearch(query: string): void {
  const value = query.trim();
  if (!value) return;
  const normalized = value.toLocaleLowerCase();
  const now = Date.now();
  searchHistory = searchHistory.filter((entry) => entry.query.toLocaleLowerCase() !== normalized);
  searchHistory.unshift({ query: value.slice(0, 500), at: now });
  searchHistory = searchHistory.slice(0, SEARCH_HISTORY_LIMIT);
  renderSearchHistory();
  void queueHistoryRequest(() => call<SearchHistoryResult>("skills.recordSearch", {
    query: value.slice(0, 500),
    at: now,
  }));
}

function clearSearchHistory(): void {
  searchHistory = [];
  searchHistoryExpanded = false;
  renderSearchHistory();
  status("已清除搜索历史");
  void queueHistoryRequest(() => call<SearchHistoryResult>("skills.clearSearchHistory", {}));
}

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
function attachedSkills(context = hostModelContext): AttachedSkill[] {
  const structured = context?.structuredContent;
  if (!structured) return [];
  const raw = Array.isArray(structured.skills)
    ? structured.skills
    : structured.skill && typeof structured.skill === "object"
      ? [structured.skill]
      : [];
  const seen = new Set<string>();
  return raw.flatMap((value): AttachedSkill[] => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name.trim()) return [];
    const name = item.name.trim();
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const instructionChars = Number(item.instruction_chars);
    return [{
      name,
      uri: typeof item.uri === "string" ? item.uri : skillUri(name),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(typeof item.category === "string" ? { category: item.category } : {}),
      ...(typeof item.local_path === "string" || item.local_path === null
        ? { local_path: item.local_path }
        : {}),
      ...(Number.isFinite(instructionChars) ? { instruction_chars: instructionChars } : {}),
    }];
  });
}
function handoffBlockSkill(block: Record<string, unknown>): string | undefined {
  const meta = block._meta;
  if (meta && typeof meta === "object" && typeof (meta as Record<string, unknown>)[HANDOFF_BLOCK_META] === "string") {
    return (meta as Record<string, string>)[HANDOFF_BLOCK_META];
  }
  if (block.type === "resource_link" && typeof block.uri === "string" && block.uri.startsWith("skill://")) {
    const encoded = block.uri.slice("skill://".length);
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  if (block.type === "text" && typeof block.text === "string") {
    const firstLine = block.text.split("\n", 1)[0];
    const prefix = "## 已选择技能：";
    return firstLine.startsWith(prefix) ? firstLine.slice(prefix.length).trim() : undefined;
  }
  return undefined;
}
function renderAttachedBar(attached = attachedSkills()): void {
  attachedBar.hidden = attached.length === 0;
  attachedSummary.textContent = attached.length > 0
    ? `${attached.length} 个技能 · 输入框不显示，下一条消息可用`
    : "";
  attachedClear.disabled = attaching || attached.length === 0;
  attachedList.replaceChildren(...attached.map((skill) => {
    const chip = document.createElement("span");
    chip.className = "attached-chip";
    const name = document.createElement("b");
    name.textContent = skill.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = `从当前对话移除 ${skill.name}`;
    remove.setAttribute("aria-label", `从当前对话移除 ${skill.name}`);
    remove.disabled = attaching;
    remove.onclick = () => void removeAttachedSkills([skill.name]);
    chip.append(name, remove);
    return chip;
  }));
}
function attachmentNotice(message: string): void {
  if (view.view === "detail") attachmentStatus(message);
  else status(message);
}
async function removeAttachedSkills(names: string[], clearAll = false): Promise<void> {
  if (attaching || !connected) return;
  const current = attachedSkills();
  if (current.length === 0) return;
  const removeKeys = new Set((clearAll ? current.map((item) => item.name) : names)
    .map((name) => name.toLocaleLowerCase()));
  const remaining = current.filter((item) => !removeKeys.has(item.name.toLocaleLowerCase()));
  if (remaining.length === current.length) return;

  attaching = true;
  updateAttachButton();
  try {
    const content = clearAll
      ? []
      : (Array.isArray(hostModelContext?.content) ? hostModelContext.content : [])
          .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
          .filter((block) => {
            const owner = handoffBlockSkill(block)?.toLocaleLowerCase();
            return !owner || !removeKeys.has(owner);
          });
    const structuredContent = {
      ...(hostModelContext?.structuredContent ?? {}),
      skill: remaining[0] ?? null,
      skills: remaining,
      instruction_chars: remaining.reduce(
        (total, item) => total + Math.max(0, item.instruction_chars ?? 0),
        0,
      ),
      handoff: remaining.length > 0 ? "full-skill-md" : "removed",
    };
    const result = await transport.request<ModelContextUpdateResult>("ui/update-model-context", {
      content,
      structuredContent,
    }, 15_000);
    if (result?.isError) throw new Error("宿主未接受移除请求");
    hostModelContext = {
      content,
      structuredContent,
      updateId: result?._meta?.["openai/modelContext"]?.updateId,
    };
    attachmentNotice(clearAll
      ? "已清空带入技能；下一条消息不再附带这些技能。"
      : `已从当前对话移除「${names.join("、")}」；下一条消息不再附带该技能。`);
  } catch (error) {
    attachmentNotice(`移除失败：${errorMessage(error)}`);
  } finally {
    attaching = false;
    updateAttachButton();
  }
}
function updateAttachButton() {
  const ready = connected && view.view === "detail" &&
    !detailMaterializing && !!detailInstructions.trim();
  const attached = attachedSkills();
  const selected = view.view === "detail" ? view : undefined;
  const alreadyAttached = !!selected &&
    attached.some((item) => item.name.toLocaleLowerCase() === selected.skill.name.toLocaleLowerCase());
  attach.textContent = alreadyAttached
    ? "更新已带入技能"
    : attached.length > 0
      ? "再带入此技能"
      : "带入当前对话";
  attach.disabled = attaching || !ready;
  attach.title = !connected
    ? "技能库尚未连接"
    : detailMaterializing
      ? "技能正在下载并校验；完成前不会提交任何技能内容"
      : !detailInstructions.trim()
        ? "完整说明尚未加载；完成前不会提交任何技能内容"
        : alreadyAttached
          ? `「${selected!.skill.name}」已在当前对话中；输入框不会显示技能，再次点击可刷新`
          : attached.length > 0
            ? `当前已带入 ${attached.length} 个技能；输入框不会显示，点击会合并此技能`
            : "点击后带入当前对话；输入框不会显示技能，下一条消息可直接使用";
  detailFlow.textContent = attached.length > 0
    ? `已带入 ${attached.length} 个技能；下一条消息直接描述任务即可。`
    : detailMaterializing
      ? "正在准备完整技能；完成后点击“带入当前对话”。"
      : "① 查看技能说明（README） → ② 带入当前对话 → ③ 在下一条消息里直接描述任务";
  detailFlow.className = "detail-flow" + (attached.length > 0 ? " ready" : "");
  renderAttachedBar(attached);
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
function stopProgressPolling() {
  if (progressPollTimer !== undefined) clearInterval(progressPollTimer);
  progressPollTimer = undefined;
  progressPollLoading = false;
}
function showDownloadProgress(done?: number, total?: number) {
  detailMaterializing = true;
  updateClearCacheButton();
  detailProgress.hidden = false;
  if (done === undefined || total === undefined || total <= 0) {
    detailProgress.className = "download-progress indeterminate";
    progressFill.style.width = "";
    progressPercent.textContent = "准备中";
    progressMeta.textContent = "正在读取文件清单…";
    detailProgress.setAttribute("aria-valuenow", "0");
    detailProgress.setAttribute("aria-valuetext", "正在准备缓存");
    return;
  }
  const safeTotal = Math.max(1, total);
  const safeDone = Math.max(0, Math.min(safeTotal, done));
  const percent = Math.min(100, Math.round((safeDone / safeTotal) * 100));
  detailProgress.className = "download-progress";
  progressFill.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  progressMeta.textContent = `${safeDone.toLocaleString("zh-CN")} / ${safeTotal.toLocaleString("zh-CN")} 个文件`;
  detailProgress.setAttribute("aria-valuenow", String(percent));
  detailProgress.setAttribute("aria-valuetext", `正在缓存 ${safeDone} / ${safeTotal} 个文件`);
}
function startProgressPolling(name: string, token: number) {
  stopProgressPolling();
  const poll = async () => {
    if (disposed || revision !== token || view.view !== "detail") {
      stopProgressPolling();
      return;
    }
    if (progressPollLoading) return;
    progressPollLoading = true;
    try {
      const result = await call<{ progress: DownloadProgress | null }>("skills.progress", { name });
      if (disposed || revision !== token || view.view !== "detail") return;
      const progress = result.progress;
      if (!progress) return;
      showDownloadProgress(progress.done, progress.total);
      $("d-cache-detail").textContent = "正在从源仓库下载并校验文件";
    } catch {
      // The resource request remains authoritative; a diagnostics-only poll
      // failure should not interrupt the download.
    } finally {
      progressPollLoading = false;
    }
  };
  void poll();
  progressPollTimer = setInterval(() => void poll(), 750);
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatBytes = (bytes = 0) => {
  if (bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};
const formatCount = (value = 0) => Math.max(0, value).toLocaleString("zh-CN");
const relativeTime = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) return "最近未使用";
  const elapsed = Math.max(0, Date.now() - value);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚使用";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} 个月前` : `${Math.floor(months / 12)} 年前`;
};
const fileTypeLabel = (mime?: string) => {
  const labels: Record<string, string> = {
    "application/pdf": "PDF 文档",
    "application/msword": "Word 文档（旧版）",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word 文档",
    "application/vnd.ms-excel": "Excel 工作簿（旧版）",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel 工作簿",
    "application/vnd.ms-excel.sheet.macroEnabled.12": "Excel 启用宏工作簿",
    "application/vnd.ms-powerpoint": "PowerPoint 演示文稿（旧版）",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint 演示文稿",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "PowerPoint 放映文件",
    "application/zip": "ZIP 压缩包",
    "application/x-7z-compressed": "7z 压缩包",
    "application/vnd.rar": "RAR 压缩包",
    "application/x-tar": "TAR 归档",
    "application/gzip": "Gzip 压缩文件",
  };
  return (mime && labels[mime]) || mime || "未知类型";
};
const skillUri = (name: string) => `skill://${encodeURIComponent(name)}`;
const skillFileUri = (name: string, path: string) =>
  `${skillUri(name)}/${path.split("/").map(encodeURIComponent).join("/")}`;
const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function setInstructionMode(mode: "rendered" | "raw") {
  instructionMode = mode;
  renderedInstructions.hidden = mode !== "rendered";
  instructionRaw.hidden = mode !== "raw";
  instructionToggle.textContent = mode === "rendered" ? "查看原文" : "返回渲染";
  instructionToggle.setAttribute("aria-pressed", String(mode === "raw"));
}

function renderDocument(text: string, source: string) {
  documentSource.textContent = source;
  const previewText = text.length > DETAIL_PREVIEW_LIMIT
    ? text.slice(0, DETAIL_PREVIEW_LIMIT) + "\n…（界面预览已截断；带入技能时会发送完整 SKILL.md）"
    : text;
  instructionRaw.textContent = previewText;
  const displayText = previewText.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  try {
    const parsed = marked.parse(displayText.trimStart() || previewText, { async: false, gfm: true, breaks: false });
    renderedInstructions.innerHTML = DOMPurify.sanitize(String(parsed), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["img", "video", "audio", "iframe", "object", "embed", "form", "input", "button", "style", "link", "meta"],
      FORBID_ATTR: ["style"],
    });
  } catch {
    renderedInstructions.innerHTML = `<pre>${escapeHtml(displayText.trimStart() || previewText)}</pre>`;
  }
  if (typeof renderedInstructions.querySelectorAll === "function") {
    renderedInstructions.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
      const href = link.getAttribute("href")?.trim() ?? "";
      if (/^(?:https?:|mailto:)/i.test(href)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    });
  }
  setInstructionMode("rendered");
}

function fallbackSkillOverview(skill: SkillCard, note: string): string {
  return [
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    ...(skill.category ? [`**分类：** ${skill.category}`] : []),
    "",
    "> " + note,
    "",
    "可在“文件”页查看该技能的 `SKILL.md`、脚本、参考资料和其他资源。",
  ].join("\n");
}

type RelativeMarkdownTarget = {
  path: string;
  outside: number;
  fragment: string;
};

function resolveRelativeMarkdownTarget(href: string): RelativeMarkdownTarget | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.trim());
  } catch {
    return null;
  }
  if (!decoded || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(decoded)) return null;
  const hashAt = decoded.indexOf("#");
  const fragment = hashAt >= 0 ? decoded.slice(hashAt + 1) : "";
  const pathPart = (hashAt >= 0 ? decoded.slice(0, hashAt) : decoded)
    .split("?", 1)[0]
    .replace(/\\/g, "/");
  if (!pathPart) return fragment ? { path: "", outside: 0, fragment } : null;
  const segments: string[] = [];
  let outside = 0;
  for (const segment of pathPart.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length) segments.pop();
      else outside++;
    } else {
      segments.push(segment);
    }
  }
  return segments.length || outside
    ? { path: segments.join("/"), outside, fragment }
    : null;
}

function openMarkdownLink(href: string) {
  if (/^(?:https?:|mailto:)/i.test(href)) {
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    if (!opened) status(`浏览器阻止了外部链接，可复制地址访问：${href}`);
    return;
  }
  const target = resolveRelativeMarkdownTarget(href);
  if (!target) {
    status("已阻止不支持的链接");
    return;
  }
  if (target.fragment && !target.path) {
    const decoded = (() => {
      try { return decodeURIComponent(target.fragment); } catch { return target.fragment; }
    })();
    const element = document.getElementById(decoded);
    element?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    if (!element) status("当前说明中没有找到这个段落锚点");
    return;
  }
  if (target.outside > 0) {
    if (target.path === "SKILL.md" && butlerName) {
      const destination = view.view === "detail" ? view.from : { view: "home" as const };
      void navigate({
        view: "detail",
        skill: { name: butlerName, description: "技能库全局路由入口", cached: false },
        from: destination,
      });
      return;
    }
    status("该链接指向当前技能包之外，已阻止界面跳转");
    return;
  }
  setDetailTab("files");
  void openFile(target.path);
}

renderedInstructions.addEventListener("click", (event) => {
  const anchor = (event.target as Element | null)?.closest?.("a") as HTMLAnchorElement | null;
  const href = anchor?.getAttribute("href")?.trim();
  if (!href) return;
  event.preventDefault();
  openMarkdownLink(href);
});

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await transport.request<ToolResult<T>>("tools/call", { name, arguments: args }, 60_000);
  if (result?.isError) {
    throw new Error(result.content?.find((item) => item.type === "text")?.text || `工具 ${name} 调用失败`);
  }
  if (!result?.structuredContent) throw new Error("服务未返回结构化数据");
  return result.structuredContent;
}

async function readResource(
  uri: string,
  progressToken?: string,
  meta: Record<string, unknown> = {},
): Promise<ResourceReadResult> {
  const resourceMeta = {
    ...(progressToken ? { progressToken } : {}),
    ...meta,
  };
  const result = await transport.request<{
    contents?: { text?: string; _meta?: Record<string, unknown> }[];
  }>("resources/read", {
    uri,
    ...(Object.keys(resourceMeta).length ? { _meta: resourceMeta } : {}),
  }, 90_000);
  const item = result?.contents?.find((entry) => typeof entry.text === "string");
  if (typeof item?.text !== "string") throw new Error("服务未返回文件文本");
  return { text: item.text, meta: item._meta ?? {} };
}

async function readResourceText(
  uri: string,
  progressToken?: string,
  meta: Record<string, unknown> = {},
): Promise<string> {
  return (await readResource(uri, progressToken, meta)).text;
}

function card(skill: SkillCard): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "card";
  const title = document.createElement("b"); title.textContent = skill.name;
  const description = document.createElement("p"); description.textContent = skill.description;
  const meta = document.createElement("div"); meta.className = "card-meta";
  const badge = document.createElement("span");
  badge.className = "badge" + (skill.cached ? " on" : "");
  badge.textContent = skill.cached ? "已缓存" : "按需下载";
  const usage = document.createElement("span");
  usage.className = "usage-chip" + ((skill.reads ?? 0) >= 3 ? " hot" : "");
  usage.textContent = (skill.reads ?? 0) > 0
    ? `调用 ${formatCount(skill.reads)} 次 · ${relativeTime(skill.last_used_at)}`
    : "尚未调用";
  usage.title = (skill.reads ?? 0) > 0
    ? `累计调用 ${skill.reads} 次${skill.failures ? `，失败 ${skill.failures} 次` : ""}`
    : "这张卡来自近期更新或推荐排序";
  const category = skill.category
    ? (() => { const chip = document.createElement("span"); chip.className = "meta-chip"; chip.textContent = skill.category; return chip; })()
    : undefined;
  const size = skill.size_bytes !== undefined
    ? (() => {
        const chip = document.createElement("span");
        chip.className = "meta-chip";
        chip.textContent = skill.size_bytes > 0 ? formatBytes(skill.size_bytes) : "体积未知";
        chip.title = skill.size_bytes > 0 ? "完整技能下载体积" : "源清单还没有提供体积";
        return chip;
      })()
    : undefined;
  const match = skill.match_reasons?.length
    ? (() => {
        const chip = document.createElement("span");
        chip.className = "meta-chip match";
        chip.textContent = `匹配：${skill.match_reasons.slice(0, 2).join("、")}`;
        chip.title = skill.match_reasons.join("、");
        return chip;
      })()
    : undefined;
  meta.append(
    badge,
    ...(category ? [category] : []),
    ...(size ? [size] : []),
    usage,
    ...(match ? [match] : []),
  );
  button.append(title, description, meta);
  button.onclick = () => {
    if (view.view !== "detail") void navigate({ view: "detail", skill, from: view });
  };
  return button;
}
function renderCards(host: HTMLElement, skills: SkillCard[]) {
  host.replaceChildren(...skills.map(card));
}
function renderCategories(categories: Category[]) {
  $("cats").replaceChildren(...categories.map((category, index) => {
    const button = document.createElement("button"); button.className = "cat";
    const marker = document.createElement("span"); marker.className = "cat-index";
    marker.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("span"); copy.className = "cat-copy";
    const name = document.createElement("b"); name.textContent = category.name;
    const count = document.createElement("span"); count.className = "muted";
    count.textContent = `${formatCount(category.skill_count)} 个`;
    const arrow = document.createElement("span"); arrow.className = "cat-arrow"; arrow.textContent = "→";
    copy.append(name, count);
    button.append(marker, copy, arrow);
    button.onclick = () => void navigate({ view: "category", category: category.name });
    return button;
  }));
}

function renderHomeMeta(data: BrowseResult) {
  if (data.cache_mode) cacheMode = data.cache_mode;
  if (data.butler) butlerName = data.butler;
  const total = data.totalSkills ?? 0;
  const categories = data.categories?.length ?? 0;
  const usage = data.usage ?? { total_reads: 0, used_skills: 0, total_failures: 0 };
  $("hero-kicker").textContent = `${formatCount(total)} 个顶层技能 · 实时索引`;
  $("stat-total").textContent = formatCount(total);
  $("stat-categories").textContent = formatCount(categories);
  $("stat-usage").textContent = formatCount(usage.total_reads);
  $("stat-explored").textContent = formatCount(usage.used_skills);
  $("section-title").textContent = usage.total_reads > 0 ? "常用技能" : "近期值得探索";
  $("section-caption").textContent = usage.total_reads > 0
    ? "按本地读取频率排序，并标出真实调用次数与最近使用时间。"
    : "还没有足够的本地调用记录；先展示近期更新与推荐入口。";
  $("usage-summary").textContent = usage.total_reads > 0
    ? `已使用 ${formatCount(usage.used_skills)} 个 · 共 ${formatCount(usage.total_reads)} 次`
    : "等待首次调用";
  updateClearCacheButton();
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

function syncPreviewHostButton() {
  previewOpenHost.hidden = !detailLocalPath || $("file-preview").hidden;
}

function openSuggestModal() {
  suggestReturnFocus = (document.activeElement as HTMLElement | null) ?? null;
  $("suggest-copy-status").textContent = "";
  suggestModal.hidden = false;
  document.body?.classList.add("modal-open");
  setTimeout(() => $("suggest-close").focus?.(), 0);
}

function closeSuggestModal() {
  if (suggestModal.hidden) return;
  suggestModal.hidden = true;
  document.body?.classList.remove("modal-open");
  suggestReturnFocus?.focus?.();
  suggestReturnFocus = null;
}

function cacheBadge(state?: CacheSkill) {
  lastCacheState = state;
  const badge = $("d-cached");
  const detail = $("d-cache-detail");
  const revisionNote = $("d-revision-note");
  badge.className = "badge";
  detail.textContent = "";
  revisionNote.hidden = true;
  if (!state || !state.found) {
    detailLocalPath = "";
    badge.textContent = state ? "技能不存在" : "检查缓存…";
    badge.className = "badge warn";
    syncPreviewHostButton();
    updateClearCacheButton();
    return;
  }
  if (state.root) {
    detailLocalPath = "";
    badge.textContent = "全局入口";
    badge.className = "badge router";
    detail.textContent = "直接读取源仓库根 SKILL.md · 随源更新";
    syncPreviewHostButton();
    updateClearCacheButton();
    return;
  }
  detailLocalPath = state.local_path ?? "";
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
    detail.textContent = "读取说明时会下载完整技能（含脚本与资源）";
  }
  syncPreviewHostButton();
  updateClearCacheButton();
}

function resetClearCacheButton() {
  if (clearCacheTimer !== undefined) clearTimeout(clearCacheTimer);
  clearCacheTimer = undefined;
  clearCacheArmed = false;
  clearCacheButton.className = "";
  clearCacheButton.textContent = "清除缓存";
  clearCacheButton.setAttribute("aria-label", "");
}

function updateClearCacheButton() {
  if (clearCacheBusy) {
    clearCacheButton.hidden = cacheMode === "local";
    clearCacheButton.disabled = true;
    clearCacheButton.textContent = "正在清除…";
    return;
  }
  const armed = clearCacheArmed;
  resetClearCacheButton();
  clearCacheBusy = false;
  if (cacheMode === "local" || lastCacheState?.cacheable === false) {
    clearCacheButton.hidden = true;
    clearCacheButton.disabled = true;
    return;
  }
  clearCacheButton.hidden = false;
  const canClear = !!lastCacheState?.found && !!lastCacheState.cached && !detailMaterializing;
  clearCacheButton.disabled = !canClear;
  clearCacheButton.title = canClear
    ? "删除这个技能已下载的文件，释放本地空间"
    : detailMaterializing ? "技能正在下载，完成后可清除" : "当前没有可清除的技能缓存";
  if (armed && canClear) {
    clearCacheArmed = true;
    clearCacheButton.className = "armed";
    clearCacheButton.textContent = "再次点击确认";
    clearCacheButton.setAttribute("aria-label", "再次点击确认清除当前技能缓存");
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
  detailMaterializing = false;
  const rootSkill = view.view === "detail" && view.skill.name === butlerName;
  lastCacheState = {
    ...lastCacheState,
    name: view.view === "detail" ? view.skill.name : lastCacheState?.name ?? "",
    found: true,
    cached: true,
    complete: true,
  };
  cacheStatusRevision++;
  const badge = $("d-cached");
  badge.textContent = rootSkill ? "全局入口" : "已完整缓存";
  badge.className = rootSkill ? "badge router" : "badge on";
  $("d-cache-detail").textContent = rootSkill
    ? "直接读取源仓库根 SKILL.md · 随源更新"
    : "正在读取文件统计…";
  $("d-revision-note").hidden = true;
  detailProgress.hidden = true;
  stopProgressPolling();
  updateClearCacheButton();
  updateAttachButton();
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
  previewCopyPath = detailLocalPath ? `${detailLocalPath.replace(/[\\/]$/, "")}/${path}` : path;
  previewCopyButton.textContent = detailLocalPath ? "复制完整路径" : "复制路径";
  $("preview-path").textContent = path;
  previewContent.hidden = false;
  previewContent.textContent = "正在读取文件…";
  previewImage.src = "";
  previewImage.alt = "";
  previewImageWrap.hidden = true;
  previewMediaMeta.textContent = "";
  previewMore.hidden = true;
  $("file-preview").hidden = false;
  syncPreviewHostButton();
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
    if (result.binary && result.mime_type?.startsWith("image/")) {
      previewNextOffset = undefined;
      previewMore.hidden = true;
      previewContent.hidden = true;
      previewImageWrap.hidden = false;
      previewMediaMeta.textContent =
        `${result.mime_type.toUpperCase()} · ${formatBytes(result.size_bytes)}`;
      previewImage.alt = path;
      previewImage.src = "";
      const image = await call<ImagePreviewResult>("skills.previewImage", {
        name: selected.skill.name,
        path,
      });
      if (disposed || view !== selected || previewRevision !== token) return;
      previewImage.src = `data:${image.mime_type};base64,${image.data_base64}`;
      return;
    }
    const combined = (append ? previewText : "") + result.content;
    const limited = combined.length > FILE_PREVIEW_CHARS;
    previewText = result.binary
      ? `这是 ${fileTypeLabel(result.mime_type)}（${formatBytes(result.size_bytes)}）。\n\nApp 不解析这类内部字节。请点击“在 Codex 中打开”，交给宿主查看器或对应技能处理；也可复制完整路径手动打开。`
      : limited ? combined.slice(0, FILE_PREVIEW_CHARS) + "\n…（界面预览已达到 1M 字符上限）" : combined;
    previewNextOffset = result.binary || limited ? undefined : result.next_offset;
    previewContent.hidden = false;
    previewImageWrap.hidden = true;
    previewContent.textContent = previewText;
    previewMore.hidden = !previewNextOffset;
  } catch (error) {
    if (disposed || view !== selected || previewRevision !== token) return;
    previewImageWrap.hidden = true;
    previewContent.hidden = false;
    if (append) previewContent.textContent = previewText + `\n\n读取下一段失败：${errorMessage(error)}`;
    else previewContent.textContent = `读取失败：${errorMessage(error)}`;
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
  previewCopyPath = "";
  $("file-preview").hidden = true;
  previewContent.textContent = "";
  previewContent.hidden = false;
  previewImage.src = "";
  previewImage.alt = "";
  previewImageWrap.hidden = true;
  previewMediaMeta.textContent = "";
  syncPreviewHostButton();
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
  $("search-zone").hidden = next.view === "detail";
  $("search-hint").hidden = next.view === "detail";
  $("content").setAttribute("data-view", next.view);
  $("heading").textContent = next.view === "category" ? next.category :
    next.view === "search" ? "搜索结果" :
    next.view === "detail" ? next.skill.name : "Codex Skills 技能库";
  $("eyebrow").textContent = next.view === "category" ? "Library · category" :
    next.view === "search" ? "Library · search result" :
    next.view === "detail" ? "Skill dossier" : "Skill atlas · on demand";
  $("count").textContent = "";
  $("empty").hidden = true;
  if (next.view !== "detail") search.value = next.view === "search" ? next.query : "";
  if (next.view === "detail") {
    if (previous !== next) attachmentStatus("");
    cacheStatusRevision++;
    resetClearCacheButton();
    const rootSkill = next.skill.name === butlerName;
    detailMaterializing = !rootSkill && !next.skill.cached;
    detailInstructions = "";
    cacheBadge();
    documentSource.textContent = "加载中";
    instructionRaw.textContent = "正在读取技能简介与 README…";
    renderedInstructions.textContent = "正在读取技能简介与 README…";
    setInstructionMode("rendered");
    $("d-cache-detail").textContent = "";
    if (next.skill.cached || rootSkill) detailProgress.hidden = true;
    else showDownloadProgress();
    stopProgressPolling();
    updateAttachButton();
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
  renderSearchHistory();
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
      startProgressPolling(next.skill.name, token);
      const instructions = await readResourceText(skillUri(next.skill.name), detailProgressToken);
      // Materialization succeeded even if the user has already navigated away.
      next.skill.cached = true;
      if (!current()) return;
      detailInstructions = instructions;
      renderDocument(
        fallbackSkillOverview(next.skill, "正在读取技能包中的 README.md…"),
        "技能简介",
      );
      markMaterialized();
      status("技能已缓存，正在读取 README…");
      try {
        const readmeResult = await readResource(
          skillFileUri(next.skill.name, "README.md"),
          undefined,
          {
            "codex-skills/display": "readme",
            "codex-skills/preferred-language": "zh-CN",
          },
        );
        if (!current()) return;
        const readmePath = typeof readmeResult.meta["codex-skills/readme-path"] === "string"
          ? readmeResult.meta["codex-skills/readme-path"]
          : "README.md";
        renderDocument(
          readmeResult.text.trim()
            ? readmeResult.text
            : fallbackSkillOverview(next.skill, "技能包中的 README.md 为空。"),
          readmeResult.text.trim() ? readmePath : "技能简介",
        );
        status(readmeResult.text.trim()
          ? `${readmePath} 已加载；可切换文件或子技能继续查看`
          : "README.md 为空，当前显示技能简介");
      } catch (readmeError) {
        if (!current()) return;
        renderDocument(
          fallbackSkillOverview(
            next.skill,
            "该技能没有返回可显示的 README.md（可能未提供或暂时无法读取）。",
          ),
          "技能简介",
        );
        status(`README 不可用，已显示技能简介：${errorMessage(readmeError)}`);
      }
      updateAttachButton();
      void refreshCacheStatus(next.skill.name, token);
    } else {
      const data = await cached(JSON.stringify(next), () => next.view === "search"
        ? call<BrowseResult>("skills.query", { query: next.query, limit: 24 })
        : call<BrowseResult>("skills.browse", next.view === "category" ? { category: next.category } : {}));
      if (!current()) return;
      if (next.view === "home") {
        $("count").textContent = `${formatCount(data.totalSkills ?? 0)} 顶层技能`;
        renderHomeMeta(data);
        renderCards($("cards"), data.top ?? []);
        renderCategories(data.categories ?? []);
        status(data.totalSkills ? "输入技能关键词，或从常用技能与领域开始" : "技能库为空，请检查服务端技能源配置");
      } else {
        const skills = (next.view === "search" ? data.results : data.skills) ?? [];
        if (next.view === "search") {
          rememberSearch(next.query);
          currentSearch = data;
          $("count").textContent = `${skills.length}/${data.total ?? skills.length} 结果`;
        } else {
          $("count").textContent = `${skills.length} 个`;
        }
        renderCards($("cards-list"), skills);
        $("empty").hidden = skills.length !== 0;
        $("empty").textContent = next.view === "search" ? "没有找到匹配技能，试试更短的关键词，例如 PPT、视频翻译、小红书。" : "该分类暂无技能。";
        status(skills.length ? "选择技能查看详情" : "没有匹配结果");
        if (next.view === "search") updateSearchMore();
      }
    }
  } catch (error) {
    if (!current()) return;
    if (next.view === "detail") {
      const failure = "读取未完成。技能可能仍在后台下载，重试可继续获取内容。";
      detailInstructions = "";
      documentSource.textContent = "加载失败";
      instructionRaw.textContent = failure;
      renderedInstructions.textContent = failure;
      detailProgress.hidden = true;
      detailMaterializing = false;
      updateAttachButton();
      updateClearCacheButton();
      stopProgressPolling();
      void refreshCacheStatus(next.skill.name, token);
    }
    status(`加载失败：${errorMessage(error)}`, () => void navigate(next));
  } finally {
    if (current()) busy(false);
  }
}

attach.onclick = async () => {
  if (view.view !== "detail" || attaching || !connected || detailMaterializing) return;
  const selected = view;
  const skill = selected.skill;
  if (!detailInstructions.trim()) {
    attachmentStatus("完整技能尚未缓存完成，请稍后再带入（不会自动发起对话）");
    return;
  }
  attaching = true; attach.disabled = true;
  updateAttachButton();
  attachmentStatus(`正在将「${skill.name}」的完整技能带入对话…`);
  try {
    const handoff = [
      `## 已选择技能：${skill.name}`,
      "",
      "这是用户从 Codex Skills 技能库中明确选择的技能。请将下面的 SKILL.md 视为当前对话中该技能的权威工作流：在执行用户任务前完整阅读并遵循其中的步骤、工具和限制；需要额外文件时使用 load_skill_file 或对应 skill:// 资源，不要用通用知识替代。",
      "",
      `- 描述：${skill.description}`,
      `- 技能资源：${skillUri(skill.name)}`,
      ...(detailLocalPath ? [`- 本地缓存：${detailLocalPath}`] : []),
      `- 指令大小：${detailInstructions.length} 字符`,
      "",
      "--- BEGIN SKILL.md ---",
      detailInstructions,
      "--- END SKILL.md ---",
    ].join("\n");
    const selectedSkill: AttachedSkill = {
      name: skill.name,
      uri: skillUri(skill.name),
      description: skill.description,
      ...(skill.category ? { category: skill.category } : {}),
      local_path: detailLocalPath || null,
      instruction_chars: detailInstructions.length,
    };
    const normalizedName = skill.name.toLocaleLowerCase();
    const previousSkills = attachedSkills()
      .filter((item) => item.name.toLocaleLowerCase() !== normalizedName);
    const nextSkills = [...previousSkills, selectedSkill];
    const existingContent = Array.isArray(hostModelContext?.content)
      ? hostModelContext.content.filter((block): block is Record<string, unknown> =>
          !!block && typeof block === "object")
      : [];
    const content: Record<string, unknown>[] = [
      ...existingContent.filter((block) =>
        handoffBlockSkill(block)?.toLocaleLowerCase() !== normalizedName),
      {
        type: "text",
        text: handoff,
        annotations: { audience: ["assistant"] },
        _meta: {
          "openai/title": `完整技能：${skill.name}`,
          [HANDOFF_BLOCK_META]: skill.name,
        },
      },
    ];
    const supportsResourceLink = !!hostCapabilities?.updateModelContext?.resourceLink;
    if (supportsResourceLink) {
      content.push({
        type: "resource_link",
        uri: skillUri(skill.name),
        name: skill.name,
        title: skill.name,
        description: skill.description,
        mimeType: "text/markdown",
        annotations: { audience: ["assistant"] },
        _meta: { [HANDOFF_BLOCK_META]: skill.name },
      });
    }
    const structuredContent = {
      ...(hostModelContext?.structuredContent ?? {}),
      skill: selectedSkill,
      skills: nextSkills,
      instruction_chars: nextSkills.reduce(
        (total, item) => total + Math.max(0, item.instruction_chars ?? 0),
        0,
      ),
      handoff: "full-skill-md",
    };
    const result = await transport.request<ModelContextUpdateResult>("ui/update-model-context", {
      content,
      structuredContent,
    }, 15_000);
    if (result?.isError) throw new Error("宿主未接受技能上下文");
    hostModelContext = {
      content,
      structuredContent,
      updateId: result?._meta?.["openai/modelContext"]?.updateId,
    };
    updateAttachButton();
    if (view === selected && !disposed) {
      attachmentStatus(nextSkills.length === 1
        ? `已将「${skill.name}」技能带入当前对话；输入框无显示，但已带入，下一条消息可直接使用。`
        : `已将「${skill.name}」等 ${nextSkills.length} 个技能带入当前对话；输入框无显示，但已带入，下一条消息可直接使用。`);
    }
  } catch (error) {
    if (view === selected && !disposed) attachmentStatus(`加入失败：${errorMessage(error)}`);
  } finally {
    attaching = false;
    updateAttachButton();
  }
};
attachedClear.onclick = () => {
  if (!attaching) void removeAttachedSkills([], true);
};

clearCacheButton.onclick = async () => {
  if (view.view !== "detail" || clearCacheBusy || cacheMode === "local") return;
  const selected = view;
  if (detailMaterializing || !lastCacheState?.cached) return;
  if (!clearCacheArmed) {
    clearCacheArmed = true;
    updateClearCacheButton();
    clearCacheTimer = setTimeout(() => {
      clearCacheTimer = undefined;
      clearCacheArmed = false;
      updateClearCacheButton();
    }, 4_000);
    status(`再次点击“确认”清除「${selected.skill.name}」的本地缓存`);
    return;
  }

  clearCacheBusy = true;
  clearCacheArmed = false;
  detailProgress.hidden = true;
  stopProgressPolling();
  updateClearCacheButton();
  try {
    const result = await call<ClearCacheResult>("skills.clearCache", { name: selected.skill.name });
    if (disposed || view !== selected) return;
    selected.skill.cached = false;
    lastCacheState = {
      ...lastCacheState,
      found: true,
      cached: false,
      complete: false,
      files_total: 0,
      files_missing_count: 0,
      size_bytes: 0,
    };
    detailLocalPath = "";
    $("d-cached").textContent = "尚未缓存";
    $("d-cached").className = "badge";
    $("d-cache-detail").textContent = result.cleared
      ? `已清除 ${formatCount(result.files_removed)} 个文件 · 释放 ${formatBytes(result.bytes_removed)}`
      : "当前没有可清除的缓存";
    $("d-revision-note").textContent = "缓存已清除；当前页面保留刚才读取的说明，下次读取会重新下载。";
    $("d-revision-note").hidden = false;
    cache.clear();
    status(result.cleared ? `已清除「${selected.skill.name}」的缓存` : "缓存已经为空");
  } catch (error) {
    if (!disposed && view === selected) {
      status(`清除缓存失败：${errorMessage(error)}`, () => clearCacheButton.click());
    }
  } finally {
    clearCacheBusy = false;
    if (!disposed && view === selected) updateClearCacheButton();
  }
};

$("back").onclick = () => void navigate(view.view === "detail" ? view.from : { view: "home" });
searchHistoryMore.onclick = () => {
  searchHistoryExpanded = !searchHistoryExpanded;
  renderSearchHistory();
};
searchHistoryClear.onclick = clearSearchHistory;
$("retry").onclick = () => retry?.();
instructionToggle.onclick = () => setInstructionMode(instructionMode === "rendered" ? "raw" : "rendered");
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
$("suggest-skill").onclick = openSuggestModal;
$("suggest-close").onclick = closeSuggestModal;
suggestModal.addEventListener("click", (event) => {
  if (event.target === suggestModal) closeSuggestModal();
});
suggestModal.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSuggestModal();
  }
});
$("suggest-copy").onclick = () => {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) {
    $("suggest-copy-status").textContent = "当前环境无法自动复制，请手动选择邮箱。";
    return;
  }
  void clipboard.writeText(suggestEmail).then(
    () => { $("suggest-copy-status").textContent = "邮箱已复制"; },
    () => { $("suggest-copy-status").textContent = "复制失败，请手动选择邮箱。"; },
  );
};
previewOpenHost.onclick = async () => {
  if (!previewCopyPath) return;
  previewOpenHost.disabled = true;
  try {
    await transport.request("openai/files/open", { path: previewCopyPath }, 15_000);
    status(`已交给 Codex 打开：${previewPath}`);
  } catch (error) {
    status(
      `宿主未能打开该文件：${errorMessage(error)}。可点击“复制路径”使用原生应用打开。`
    );
  } finally {
    previewOpenHost.disabled = false;
  }
};
previewMore.onclick = () => {
  if (previewPath && previewNextOffset !== undefined) void loadFileChunk(previewPath, previewNextOffset, true);
};
$("preview-copy").onclick = () => {
  if (!previewCopyPath) return;
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard) { $("status").textContent = `文件路径：${previewCopyPath}`; return; }
  void clipboard.writeText(previewCopyPath).then(
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
search.addEventListener("focus", () => {
  searchFocused = true;
  clearTimeout(searchBlurTimer);
  searchBlurTimer = undefined;
  syncSearchHistoryVisibility();
  void refreshSharedSearchHistory();
});
search.addEventListener("blur", () => {
  searchFocused = false;
  clearTimeout(searchBlurTimer);
  searchBlurTimer = setTimeout(() => {
    searchBlurTimer = undefined;
    syncSearchHistoryVisibility();
  }, 120);
});
search.addEventListener("input", () => {
  syncSearchHistoryVisibility();
  scheduleSearch();
});
search.addEventListener("compositionstart", () => {
  composing = true;
  syncSearchHistoryVisibility();
  cancelNavigation();
});
search.addEventListener("compositionend", () => {
  composing = false;
  syncSearchHistoryVisibility();
  scheduleSearch();
});
search.addEventListener("keydown", (event) => {
  if (event.isComposing || composing) return;
  if (event.key === "Enter") { event.preventDefault(); scheduleSearch(true); }
  if (event.key === "Escape") { search.value = ""; scheduleSearch(true); }
});
searchHistoryPanel.addEventListener("focusout", () => {
  clearTimeout(searchBlurTimer);
  searchBlurTimer = setTimeout(() => {
    searchBlurTimer = undefined;
    syncSearchHistoryVisibility();
  }, 0);
});

function applyHostContext(context: HostContext) {
  if (context.theme === "light" || context.theme === "dark") {
    document.documentElement.dataset.theme = context.theme;
    document.documentElement.style.colorScheme = context.theme;
  }
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (name.startsWith("--") && typeof value === "string") document.documentElement.style.setProperty(name, value);
  }
  if (Object.prototype.hasOwnProperty.call(context, "openai/modelContext")) {
    hostModelContext = context["openai/modelContext"] ?? null;
    updateAttachButton();
  }
}
transport.on("ui/notifications/host-context-changed", applyHostContext);
transport.on("notifications/progress", (params: {
  progressToken?: string | number; progress?: number; total?: number; message?: string;
}) => {
  if (disposed || view.view !== "detail" || String(params.progressToken) !== detailProgressToken) return;
  const total = Math.max(1, Number(params.total) || 1);
  const done = Math.max(0, Math.min(total, Number(params.progress) || 0));
  showDownloadProgress(done, total);
  $("d-cache-detail").textContent = "正在从源仓库下载并校验文件";
});
transport.handle("ping", () => ({}));
function dispose() {
  disposed = true; cancelNavigation();
  stopProgressPolling();
  cache.clear(); pending.clear();
  explorerStates = { files: emptyExplorer(), sub_skills: emptyExplorer() };
  transport.dispose();
}
transport.handle("ui/resource-teardown", () => { setTimeout(dispose, 0); return {}; });
window.addEventListener("pagehide", dispose, { once: true });
window.addEventListener("focus", () => {
  if (connected) void refreshSharedSearchHistory();
});

async function connect() {
  if (connecting || disposed) return;
  connecting = true; busy(true); search.disabled = true;
  status("正在连接技能库…");
  try {
    const result = await transport.request<InitializeResult>("ui/initialize", {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: { name: "codex-skills", version: __APP_VERSION__ },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    if (disposed) return;
    if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error(`不支持的界面协议：${result.protocolVersion}`);
    hostCapabilities = result.hostCapabilities;
    applyHostContext(result.hostContext ?? {});
    transport.notify("ui/notifications/initialized");
    connected = true; search.disabled = false;
    updateAttachButton();
    await navigate({ view: "home" });
    void refreshSharedSearchHistory().then((loaded) => {
      if (loaded) void migrateLegacySearchHistory();
    });
  } catch (error) {
    if (!disposed) { busy(false); status(`连接失败：${errorMessage(error)}`, () => void connect()); }
  } finally { connecting = false; }
}

declare const __APP_VERSION__: string;
void connect();
