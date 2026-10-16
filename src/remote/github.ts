import { writeFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, renameSync, lstatSync, chmodSync, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, dirname, join, basename, isAbsolute } from "node:path";
import type { Config, ManifestEntry } from "../config.js";
import { parseManifest } from "../config.js";
import { logEvent } from "../lib/logger.js";
import { DownloadHedger } from "./hedging.js";
import { runHttpRequest, type HttpRequestContext } from "./http-budget.js";
import { fetchRemoteManifest, type ManifestCacheSnapshot, type ManifestValidators } from "./manifest-fetch.js";

interface TreeFileEntry {
  /** Path relative to the skill directory, e.g. "README.md" or "skills/nature-reader/SKILL.md" */
  path: string;
  /** File size in bytes (from the git tree API) — used to skip already-downloaded files */
  size: number;
  /**
   * Git blob SHA from the trees API. Enables content-level change detection:
   * two versions of a file can share the same size, but never the same sha.
   * Absent in legacy cache entries (pre-revalidation) — comparison then
   * degrades to size-only.
   */
  sha?: string;
  /** Git mode from the immutable catalog; symlinks materialize as their target text */
  mode?: string;
}

interface SkillTreeCache {
  version: 1;
  /** Set only when every file in `files` has been downloaded successfully */
  completedAt?: string;
  /**
   * When the file list was last validated against the remote tree.
   * `manifestTTL` governs revalidation frequency; `manifestTTL === 0`
   * disables it (legacy never-revalidate behavior). Absent in legacy
   * entries — `completedAt` then serves as the one-time anchor.
   */
  validatedAt?: string;
  files: TreeFileEntry[];
  /** For single-file skills: absolute remote path to fetch (files.path is not prefixed) */
  singleFileRemotePath?: string;
  /** Remote source (repo/branch/path) this cache entry was fetched from */
  source?: CacheSource;
  /** Set only after this tree was loaded from the verified manifest catalog. */
  fileIndexSha256?: string;
}

/** Metadata marker written inside each cached skill directory */
const TREE_CACHE_FILE = ".codex-skills.tree.json";

/**
 * Category-wide tree cache. The repository and even single top-level
 * categories can exceed GitHub's recursive-tree truncation limit (this repo
 * is >100k files), but small categories such as the academic ones fit easily.
 * One `contents + git/trees` pair per category replaces the previous 2 API
 * calls per uncached skill, and the result is cached next to the manifest.
 */
const CATEGORY_TREE_TTL_MS = 60 * 60 * 1000;
const CATEGORY_TREE_CACHE_FILE = ".category-trees.json";

interface CategoryTreeEntry {
  /** Path relative to the category dir, e.g. "paper-search/SKILL.md" */
  path: string;
  size: number;
  /** Git blob SHA — propagated into per-skill tree caches on revalidation */
  sha?: string;
}

interface CategoryTreeData {
  fetchedAt: number;
  truncated: boolean;
  entries: CategoryTreeEntry[];
  /** Remote source (repo/branch/path) this cache entry was fetched from */
  source?: CacheSource;
}

/** Identity of the remote source a cache entry was fetched from. */
interface CacheSource {
  repo: string;
  branch: string;
  path: string;
}

/** Sidecar marker recording which remote source produced the manifest cache. */
const SOURCE_CACHE_FILE = ".codex-skills.source.json";

function cacheSource(config: Config): CacheSource {
  return {
    repo: config.githubRepo ?? "",
    branch: config.githubBranch ?? "",
    path: config.githubPath ?? "",
  };
}

/** True when a cached entry belongs to the currently configured remote source. */
function sameSource(cached: CacheSource | null | undefined, config: Config): boolean {
  if (!cached) return false;
  const current = cacheSource(config);
  return (
    cached.repo === current.repo &&
    cached.branch === current.branch &&
    cached.path === current.path
  );
}

function readSourceCache(config: Config): CacheSource | null {
  try {
    return JSON.parse(
      readFileSync(join(config.skillsDir, SOURCE_CACHE_FILE), "utf-8")
    ) as CacheSource;
  } catch {
    return null;
  }
}

function writeSourceCache(config: Config): void {
  atomicWrite(join(config.skillsDir, SOURCE_CACHE_FILE), JSON.stringify(cacheSource(config), null, 2));
}

/** Progress reporter used to emit MCP `notifications/progress` during fetches. */
export type ProgressCallback = (done: number, total: number, message: string) => void;

/** Isolate concurrent work by both its destination and remote source. */
function operationKey(config: Config, path = ""): string {
  return JSON.stringify([resolve(config.skillsDir), resolve(config.manifestPath), cacheSource(config), path]);
}

function relativePath(path: string): string {
  const clean = path.replace(/^\.\//, "");
  if (!clean || isAbsolute(clean) || clean.includes("\\") || /[\0-\x1f]/.test(clean) ||
      clean.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid relative cache path: ${JSON.stringify(path)}`);
  }
  return clean;
}

/** Reject traversal and symlink components before touching remote-controlled paths. */
function localFilePath(root: string, path: string): string {
  let current = resolve(root);
  for (const part of relativePath(path).split("/")) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink in cache path: ${path}`);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return current;
}

function validFiles(files: unknown): files is TreeFileEntry[] {
  if (!Array.isArray(files) || files.length === 0) return false;
  const seen = new Set<string>();
  return files.every((file) => {
    if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0) return false;
    try { if (relativePath(file.path) !== file.path) return false; } catch { return false; }
    if (file.path.split("/")[0] === TREE_CACHE_FILE || seen.has(file.path)) return false;
    seen.add(file.path);
    if (file.mode !== undefined && !["100644", "100755", "120000"].includes(file.mode)) return false;
    return file.sha === undefined || (typeof file.sha === "string" && /^[a-f0-9]{40}$/i.test(file.sha));
  });
}

function readTree(file: string): SkillTreeCache | null {
  try {
    const tree = JSON.parse(readFileSync(file, "utf-8")) as SkillTreeCache;
    return tree.version === 1 && validFiles(tree.files) ? tree : null;
  } catch { return null; }
}

function atomicWrite(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed or write failed */ }
  }
}

function rawUrl(config: Config, path: string): string {
  return `https://raw.githubusercontent.com/${config.githubRepo}/${encodeURIComponent(config.githubBranch ?? "main")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The timeout and optional integrity checks cover the complete response body. */
interface ResponseIntegrity {
  sha256: string;
  maxBytes: number;
}

interface TransportContext extends HttpRequestContext {
  downloadConcurrency: number;
}

function transportContext(config: Config, kind: HttpRequestContext["kind"], path: string): TransportContext {
  return { kind, group: operationKey(config, path), downloadConcurrency: config.downloadConcurrency };
}

async function fetchWithTimeout(
  url: string, options: RequestInit, timeout: number, expected: TreeFileEntry | undefined,
  integrity: ResponseIntegrity | undefined, context: TransportContext,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  // Start before admission: queued attempts consume the same existing deadline.
  const id = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeout}ms`)), timeout);
  try {
    return await runHttpRequest({ ...context, signal: controller.signal }, async () => {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (controller.signal.aborted) {
        await res.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        if (res.ok && integrity) throw new Error(`Empty response for ${url}`);
        if (res.ok && expected && expected.size !== 0) throw new Error(`Empty response for ${expected.path}`);
        if (res.ok && expected?.sha) {
          const sha = createHash("sha1").update("blob 0").update(Buffer.from([0])).digest("hex");
          if (sha !== expected.sha.toLowerCase()) throw new Error(`Git blob SHA mismatch for ${expected.path}`);
        }
        return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body.getReader();
      let cancellation: Promise<void> | undefined;
      const cancelBody = (reason: unknown) => cancellation ??= reader.cancel(reason).catch(() => {});
      const onBodyAbort = () => { void cancelBody(controller.signal.reason); };
      controller.signal.addEventListener("abort", onBodyAbort, { once: true });
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > (expected?.size ?? integrity?.maxBytes ?? 64 * 1024 * 1024)) throw new Error(`Unexpected response size for ${url}: ${size} bytes`);
          chunks.push(value);
        }
        controller.signal.throwIfAborted();
      } catch (error) {
        await cancelBody(error);
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", onBodyAbort);
        reader.releaseLock();
      }
      const body = Buffer.concat(chunks, size);
      if (integrity && createHash("sha256").update(body).digest("hex") !== integrity.sha256) {
        throw new Error(`SHA-256 mismatch for ${url}`);
      }
      if (expected) {
        if (size !== expected.size) throw new Error(`Size mismatch for ${expected.path}: expected ${expected.size}, received ${size}`);
        if (expected.sha) {
          const sha = createHash("sha1").update(`blob ${size}\0`).update(body).digest("hex");
          if (sha !== expected.sha.toLowerCase()) throw new Error(`Git blob SHA mismatch for ${expected.path}`);
        }
      }
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }, context.downloadConcurrency);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(id);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Fetch API metadata with optional auth under the shared transport budget. */
async function fetchWithAuth(
  url: string, token: string | undefined, timeout: number, context: TransportContext,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchWithTimeout(url, { headers }, timeout, undefined, undefined, context);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res;
}

interface DownloadNode {
  name: string;
  url: string;
  useAuth: boolean;
}

const downloadHedger = new DownloadHedger();

/** Race verified responses without delaying the original fallback schedule. */
async function fetchRawWithFallback(
  config: Config, path: string, expected?: TreeFileEntry, integrity?: ResponseIntegrity,
  context = transportContext(config, "metadata", path),
): Promise<Response> {
  const expectedSize = expected?.size;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const encodedBranch = encodeURIComponent(config.githubBranch ?? "main");
  const baseTimeout = config.downloadTimeout || 30000;
  // Dynamically expand timeout for large files (>5MB), assuming at least ~300KB/s transfer floor
  const dynamicTimeout = expectedSize && expectedSize > 5 * 1024 * 1024
    ? Math.max(baseTimeout, Math.min(180000, Math.ceil(expectedSize / (300 * 1024)) * 1000))
    : baseTimeout;

  const nodes: DownloadNode[] = [
    // Acceleration nodes receive only public requests, never GitHub credentials.
    ...(config.useOfficialMirror
      ? [{
          name: "Official CN",
          url: `https://gh.251716.xyz/${config.githubRepo}/${encodedBranch}/${encodedPath}`,
          useAuth: false
        }]
      : []),
    // Official direct (fastest with a working route or VPN to GitHub)
    {
      name: "GitHub Official",
      url: rawUrl(config, path),
      useAuth: true
    },
    // jsDelivr CDN (fastest in CN without VPN)
    {
      name: "jsDelivr",
      url: `https://cdn.jsdelivr.net/gh/${config.githubRepo}@${encodedBranch}/${encodedPath}`,
      useAuth: false
    },
    // gh-proxy.com
    {
      name: "gh-proxy.com",
      url: `https://gh-proxy.com/${rawUrl(config, path)}`,
      useAuth: false
    },
    // ghfast.top
    {
      name: "ghfast.top",
      url: `https://ghfast.top/${rawUrl(config, path)}`,
      useAuth: false
    }
  ];

  const result = await downloadHedger.run({
    nodes,
    // Scope routing to this cache/source and transport settings, never a token.
    key: JSON.stringify([operationKey(config), config.useOfficialMirror, !!config.githubToken]),
    path,
    enabled: config.hedgeEnabled && config.useOfficialMirror,
    verified: !!(expected?.sha || integrity),
    timeoutMs: dynamicTimeout,
  }, async (node, signal, remainingMs) => {
    const headers: Record<string, string> = {};
    if (node.useAuth && config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    const response = await fetchWithTimeout(node.url, { headers, signal }, remainingMs, expected, integrity, context);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  });
  if (result.node.name === "Official CN") {
    console.error(`[codex-skills-mcp] official endpoint won: ${path.split("/").pop()}`);
  }
  return result.value;
}

/**
 * Authoritative-first fetch for REFRESHING files that already exist locally
 * with a stale size. Mirrors can lag hours behind a fresh commit, and in a
 * race the fastest (stale) mirror would keep rewriting old bytes, leaving the
 * size mismatch forever ("missing" loop). Direct GitHub first; the mirror
 * race remains as the fallback when direct is unreachable. Brand-new files
 * keep using the mirror race, whose size and SHA checks reject stale bytes.
 */
async function fetchRawDirectFirst(config: Config, path: string, expected: TreeFileEntry, context: TransportContext): Promise<Response> {
  const headers: Record<string, string> = {};
  if (config.githubToken) headers["Authorization"] = `Bearer ${config.githubToken}`;
  const baseTimeout = config.downloadTimeout || 30000;
  const size = expected?.size ?? 0;
  const timeout = size > 5 * 1024 * 1024
    ? Math.max(baseTimeout, Math.min(180000, Math.ceil(size / (300 * 1024)) * 1000))
    : baseTimeout;
  try {
    const res = await fetchWithTimeout(rawUrl(config, path), { headers }, timeout, expected, undefined, context);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (error) {
    logEvent("warn", "refresh_direct_failed", {
      detail: `${path}: ${error instanceof Error ? error.message : String(error)} — falling back to mirror race`,
    });
    return fetchRawWithFallback(config, path, expected, undefined, context);
  }
}

/** Recover catalog-pinned bytes after a mutable branch advances. */
async function fetchCatalogFile(config: Config, path: string, file: TreeFileEntry, context: TransportContext): Promise<Response> {
  try {
    // The catalog pins the exact blob: a validated mirror is authoritative
    // for these bytes, including updates. Avoid a serial direct-only timeout.
    return await fetchRawWithFallback(config, path, file, undefined, context);
  } catch (rawError) {
    if (!file.sha) throw rawError;
    const headers: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    try {
      const response = await fetchWithTimeout(
        `https://api.github.com/repos/${config.githubRepo}/git/blobs/${file.sha}`,
        { headers }, config.downloadTimeout || 30000, file, undefined, context,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      logEvent("info", "file_blob_fallback", { detail: path });
      return response;
    } catch (blobError) {
      throw new Error(`File download failed: ${String(rawError)}; immutable blob fallback: ${String(blobError)}`);
    }
  }
}

/**
 * Build the remote repo path of a skill directory, e.g.
 * "codex-skills/00_全局大管家/12_学术论文与科研图表/nature-skills"
 */
function buildSkillRemotePath(config: Config, relPath: string): string {
  let prefix = config.githubPath ? `${config.githubPath}/${relPath}` : relPath;
  prefix = prefix.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return prefix;
}


const MAX_CATALOG_BYTES = 32 * 1024 * 1024;

function parseSkillFileCatalog(data: Buffer, entry: ManifestEntry): SkillTreeCache {
  let value: unknown;
  try { value = JSON.parse(data.toString("utf8")); } catch {
    throw new Error(`File catalog for ${entry.name} is not valid JSON`);
  }
  const catalog = value as { version?: unknown; skill_path?: unknown; files?: unknown };
  if (!catalog || catalog.version !== 1 || catalog.skill_path !== entry.relative_path || !validFiles(catalog.files) ||
      catalog.files.some((file) => !file.sha || !file.mode)) {
    throw new Error(`File catalog for ${entry.name} failed structural validation`);
  }
  const files = catalog.files;
  if (!files.some((item) => item.path === "SKILL.md")) {
    throw new Error(`File catalog for ${entry.name} has no SKILL.md`);
  }
  const index = entry.file_index;
  if (!index || files.length !== index.file_count ||
      files.reduce((sum, item) => sum + item.size, 0) !== index.total_bytes) {
    throw new Error(`File catalog for ${entry.name} does not match manifest metadata`);
  }
  return { version: 1, files, fileIndexSha256: index.sha256 };
}

function readCachedSkillFileCatalog(config: Config, entry: ManifestEntry): SkillTreeCache | null {
  const index = entry.file_index;
  if (!index) return null;
  try {
    const file = localFilePath(config.skillsDir, index.path);
    if (statSync(file).size > MAX_CATALOG_BYTES) return null;
    const data = readFileSync(file);
    if (data.byteLength > MAX_CATALOG_BYTES) return null;
    if (createHash("sha256").update(data).digest("hex") !== index.sha256) return null;
    return parseSkillFileCatalog(data, entry);
  } catch {
    return null;
  }
}

/**
 * Resolve a skill file list from the immutable manifest catalog. Returns null
 * for legacy manifests or transient catalog failures so callers can use the
 * GitHub Tree API fallback without changing the public materialize contract.
 */
async function fetchSkillTreeFromFileIndex(
  config: Config,
  entry: ManifestEntry
): Promise<SkillTreeCache | null> {
  const index = entry.file_index;
  if (!index) return null;
  const cached = readCachedSkillFileCatalog(config, entry);
  if (cached) return cached;
  try {
    const remotePath = buildSkillRemotePath(config, index.path);
    const response = await fetchRawWithFallback(config, remotePath, undefined, {
      sha256: index.sha256, maxBytes: MAX_CATALOG_BYTES,
    }, transportContext(config, "metadata", entry.relative_path));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > MAX_CATALOG_BYTES) {
      throw new Error(`unexpected catalog size ${data.byteLength}`);
    }
    if (createHash("sha256").update(data).digest("hex") !== index.sha256) {
      throw new Error("SHA-256 mismatch");
    }
    const tree = parseSkillFileCatalog(data, entry);
    atomicWrite(localFilePath(config.skillsDir, index.path), data);
    console.error(`[codex-skills-mcp] File catalog loaded for ${entry.name}: ${index.file_count} files`);
    return tree;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("warn", "file_catalog_fallback", { skill: entry.name, error: message });
    console.error(`[codex-skills-mcp] File catalog unavailable for ${entry.name} (${message}); GitHub tree fallback.`);
    return null;
  }
}

/**
 * List a skill's files with exactly 2 GitHub API calls (never the full repo tree):
 *   1. contents(parent dir)          -> locate the skill dir and get its tree SHA
 *   2. git/trees/{sha}?recursive=1   -> all blobs of that single skill subtree, with sizes
 */
async function fetchSkillTree(config: Config, relPath: string): Promise<SkillTreeCache> {
  const segments = relPath.split("/").filter(Boolean);
  const dirName = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join("/");
  const parentRemotePath = buildSkillRemotePath(config, parentPath);
  const apiBase = `https://api.github.com/repos/${config.githubRepo}/`;

  // STEP 1: find the skill directory's tree SHA from its parent listing
  const contentsRes = await fetchWithAuth(
    `${apiBase}contents/${parentRemotePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(config.githubBranch ?? "main")}`,
    config.githubToken,
    20000, transportContext(config, "metadata", relPath)
  );
  const contents = (await contentsRes.json()) as any;

  if (Array.isArray(contents)) {
    const single = contents.find((item: any) => item.name === dirName && item.type === "file");
    if (single) {
      return {
        version: 1,
        files: [{ path: dirName, size: single.size, sha: single.sha }],
        singleFileRemotePath: buildSkillRemotePath(config, relPath),
      };
    }
    const dir = contents.find(
      (item: any) => item.name === dirName && item.type === "dir"
    );
    if (!dir || !dir.sha) {
      throw new Error(`Skill directory "${dirName}" not found at "${parentRemotePath}"`);
    }

    // STEP 2: recursive tree of ONLY this skill subtree (small, not truncated)
    const treeRes = await fetchWithAuth(
      `${apiBase}git/trees/${dir.sha}?recursive=1`,
      config.githubToken,
      60000, transportContext(config, "metadata", relPath)
    );
    const tree = (await treeRes.json()) as any;
    if (tree.truncated) {
      throw new Error(`Git tree truncated for skill "${dirName}" (too many files)`);
    }

    const files: TreeFileEntry[] = (tree.tree || [])
      .filter((t: any) => t.type === "blob" && typeof t.path === "string")
      .map((t: any) => ({
        path: t.path,
        size: typeof t.size === "number" ? t.size : 0,
        sha: typeof t.sha === "string" ? t.sha : undefined,
      }));

    return { version: 1, files };
  }

  if (contents && contents.type === "file") {
    // Single-file skill: the manifest "directory" is actually one file
    return {
      version: 1,
      files: [{ path: basename(contents.path), size: contents.size ?? 0 }],
      singleFileRemotePath: `${parentRemotePath}/${dirName}`,
    };
  }

  throw new Error(
    `Unexpected GitHub Contents API response for "${parentRemotePath}": ${contentsRes.status}`
  );
}

function loadCategoryTree(config: Config, categoryPath: string): CategoryTreeData | null {
  const file = join(config.skillsDir, CATEGORY_TREE_CACHE_FILE);
  if (!existsSync(file)) return null;
  try {
    const all = JSON.parse(readFileSync(file, "utf-8")) as Record<string, CategoryTreeData>;
    const cached = all[categoryPath];
    if (!cached) return null;
    // Cache from another repo/branch must not be reused
    if (!sameSource(cached.source, config)) return null;
    if (!Number.isFinite(cached.fetchedAt) || Date.now() - cached.fetchedAt > CATEGORY_TREE_TTL_MS) return null;
    if (!Array.isArray(cached.entries) || (!cached.truncated && !validFiles(cached.entries))) return null;
    return cached;
  } catch {
    return null;
  }
}

function saveCategoryTree(
  config: Config,
  categoryPath: string,
  data: Omit<CategoryTreeData, "fetchedAt">
): void {
  const file = join(config.skillsDir, CATEGORY_TREE_CACHE_FILE);
  let all: Record<string, CategoryTreeData> = {};
  if (existsSync(file)) {
    try {
      all = JSON.parse(readFileSync(file, "utf-8")) as Record<string, CategoryTreeData>;
    } catch {
      all = {};
    }
  }
  all[categoryPath] = { ...data, source: cacheSource(config), fetchedAt: Date.now() };
  mkdirSync(config.skillsDir, { recursive: true });
  atomicWrite(file, JSON.stringify(all));
}

/**
 * Fetch the recursive tree of one category directory (contents + git/trees).
 * Returns `truncated: true` when the category is too large for the API, in
 * which case callers fall back to the per-skill path.
 */
async function fetchCategoryTree(
  config: Config,
  categoryPath: string
): Promise<Omit<CategoryTreeData, "fetchedAt">> {
  const segments = categoryPath.split("/").filter(Boolean);
  const dirName = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join("/");
  const parentRemotePath = buildSkillRemotePath(config, parentPath);
  const apiBase = `https://api.github.com/repos/${config.githubRepo}/`;

  console.error(`[codex-skills-mcp] Listing category tree: ${categoryPath}...`);
  const contentsRes = await fetchWithAuth(
    `${apiBase}contents/${parentRemotePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(config.githubBranch ?? "main")}`,
    config.githubToken,
    20000, transportContext(config, "metadata", `category:${categoryPath}`)
  );
  const contents = (await contentsRes.json()) as any;
  const dir = (Array.isArray(contents) ? contents : []).find(
    (item: any) => item.name === dirName && item.type === "dir"
  );
  if (!dir || !dir.sha) {
    throw new Error(`Category directory "${dirName}" not found at "${parentRemotePath}"`);
  }

  const treeRes = await fetchWithAuth(
    `${apiBase}git/trees/${dir.sha}?recursive=1`,
    config.githubToken,
    60000, transportContext(config, "metadata", `category:${categoryPath}`)
  );
  const tree = (await treeRes.json()) as any;
  if (tree.truncated) {
    return { truncated: true, entries: [] };
  }
  const entries: CategoryTreeEntry[] = (tree.tree || [])
    .filter((t: any) => t.type === "blob" && typeof t.path === "string")
    .map((t: any) => ({
      path: t.path,
      size: typeof t.size === "number" ? t.size : 0,
      sha: typeof t.sha === "string" ? t.sha : undefined,
    }));
  console.error(
    `[codex-skills-mcp] Category tree cached: ${entries.length} files (${categoryPath})`
  );
  return { truncated: false, entries };
}

const categoryTreeInflight = new Map<
  string,
  Promise<CategoryTreeData | null>
>();

/**
 * Ensure a category's tree is cached (deduplicated, TTL-checked). Failures and
 * truncated categories degrade gracefully to null so the per-skill API still
 * works — and truncated results are cached so we don't retry a huge category
 * repeatedly within the TTL.
 */
export async function ensureCategoryTree(
  config: Config,
  categoryPath: string
): Promise<CategoryTreeData | null> {
  relativePath(categoryPath);
  const cached = loadCategoryTree(config, categoryPath);
  if (cached) return cached;

  const key = operationKey(config, categoryPath);
  const existing = categoryTreeInflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const data = await fetchCategoryTree(config, categoryPath);
      const full: CategoryTreeData = { ...data, fetchedAt: Date.now() };
      saveCategoryTree(config, categoryPath, full);
      return full;
    } catch (error: any) {
      console.error(
        `[codex-skills-mcp] Category tree unavailable for ${categoryPath} (${error.message}); per-skill API fallback.`
      );
      return null;
    } finally {
      categoryTreeInflight.delete(key);
    }
  })();
  categoryTreeInflight.set(key, promise);
  return promise;
}

/**
 * Look up a skill's file list in its category tree cache. Returns null when
 * unavailable/truncated so callers fall back to the per-skill API path.
 */
async function fetchSkillTreeFromCategory(
  config: Config,
  entry: ManifestEntry
): Promise<SkillTreeCache | null> {
  const relPath = entry.relative_path.replace(/^\.\//, "");
  const segments = relPath.split("/").filter(Boolean);
  if (segments.length < 3) return null; // router/special entries
  const categoryPath = segments.slice(0, 2).join("/");
  const skillName = segments.slice(2).join("/");

  const data = await ensureCategoryTree(config, categoryPath);
  if (!data || data.truncated || data.entries.length === 0) return null;

  const prefix = skillName + "/";
  const files: TreeFileEntry[] = [];
  for (const entryItem of data.entries) {
    if (entryItem.path.startsWith(prefix)) {
      files.push({
        path: entryItem.path.slice(prefix.length),
        size: entryItem.size,
        sha: entryItem.sha,
      });
    }
  }
  if (files.length > 0) {
    return { version: 1, files };
  }
  // Single-file skill: the entry itself is the file.
  const exact = data.entries.find((entryItem) => entryItem.path === skillName);
  if (exact) {
    return {
      version: 1,
      files: [{ path: basename(skillName), size: exact.size, sha: exact.sha }],
      singleFileRemotePath: buildSkillRemotePath(config, `${categoryPath}/${skillName}`),
    };
  }
  return null;
}

/**
 * Run `worker` over `items` with at most `limit` concurrent executions.
 * Collects per-item errors instead of failing fast, so one bad file never
 * aborts an entire skill download.
 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const errors: Error[] = [];
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        await worker(items[index]);
      } catch (error: any) {
        errors.push(error);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run)
  );

  if (errors.length > 0) {
    throw new Error(
      `${errors.length} of ${items.length} downloads failed. First error: ${errors[0].message}`
    );
  }
}

/** True when the local file already exists with the expected size (resume support) */
function isFileUpToDate(localPath: string, expectedSize: number, mode?: string): boolean {
  try {
    const stat = statSync(localPath);
    return stat.isFile() && stat.size === expectedSize &&
      (process.platform === "win32" || !mode || (stat.mode & 0o111) === (mode === "100755" ? 0o111 : 0));
  } catch {
    return false;
  }
}

/** Incomplete markers do not attest existing bytes, even when sizes match. */
async function matchesBlob(localPath: string, file: TreeFileEntry): Promise<boolean> {
  if (!file.sha) return false;
  try {
    const hash = createHash("sha1").update(`blob ${file.size}\0`);
    let size = 0;
    for await (const chunk of createReadStream(localPath)) {
      size += chunk.length;
      if (size > file.size) return false;
      hash.update(chunk);
    }
    return size === file.size && hash.digest("hex") === file.sha.toLowerCase();
  } catch { return false; }
}

/**
 * Download every missing file of a skill, skipping files already cached.
 * Failures throw AFTER the pool finishes so the caller can resume next time.
 */
async function downloadMissing(
  config: Config,
  relPath: string,
  tree: SkillTreeCache,
  skillLocalPath: string,
  onProgress?: ProgressCallback,
  options: { force?: ReadonlySet<string>; transactional?: boolean; verifyExisting?: boolean } = {}
): Promise<void> {
  if (!validFiles(tree.files)) throw new Error("Invalid remote file tree");
  if (tree.singleFileRemotePath) relativePath(tree.singleFileRemotePath);

  const skillRemotePath = buildSkillRemotePath(config, relPath);
  const needed = new Set(tree.files.filter(
    (file) => options.force?.has(file.path) || !isFileUpToDate(localFilePath(skillLocalPath, file.path), file.size)
  ).map((file) => file.path));
  if (options.verifyExisting) {
    await runPool(tree.files, config.downloadConcurrency, async (file) => {
      if (!needed.has(file.path) && !await matchesBlob(localFilePath(skillLocalPath, file.path), file)) {
        needed.add(file.path);
      }
    });
  }
  const missing = tree.files.filter((file) => needed.has(file.path));
  const applyModes = () => {
    if (process.platform === "win32") return;
    for (const file of tree.files) {
      if (!file.mode) continue;
      const local = localFilePath(skillLocalPath, file.path);
      if (!isFileUpToDate(local, file.size, file.mode)) {
        chmodSync(local, file.mode === "100755" ? 0o755 : 0o644);
      }
    }
  };
  if (missing.length === 0) { applyModes(); return; }

  const skillName = basename(skillLocalPath);
  console.error(
    `[codex-skills-mcp] Fetching ${missing.length}/${tree.files.length} files for skill: ${skillName}...`
  );
  logEvent("info", "download_skill_start", {
    skill: skillName,
    detail: `${missing.length}/${tree.files.length} files`,
  });
  const startedAt = Date.now();
  const limit = Math.max(1, config.downloadConcurrency);
  const context = transportContext(config, "data", relPath);
  let done = 0;

  const staged: Array<{ temporary: string; target: string }> = [];
  try {
    await runPool(missing, limit, async (file) => {
      const remotePath = tree.singleFileRemotePath ?? `${skillRemotePath}/${file.path}`;
      const localFile = localFilePath(skillLocalPath, file.path);
      // A file that exists locally with the wrong size is a REFRESH of updated
      // upstream content: it must come from the authoritative source first,
      // otherwise a lagging mirror keeps rewriting stale bytes and the refresh
      // never converges (see docs/CHANGELOG.md v1.4.2). Brand-new files keep
      // the fast mirror race.
      const res = tree.fileIndexSha256 && file.sha
        ? await fetchCatalogFile(config, remotePath, file, context)
        : existsSync(localFile)
        ? await fetchRawDirectFirst(config, remotePath, file, context)
        : await fetchRawWithFallback(config, remotePath, file, undefined, context);
      const buffer = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(localFile), { recursive: true });
      if (options.transactional) {
        const temporary = join(dirname(localFile), `.${basename(localFile)}.${randomUUID()}.tmp`);
        staged.push({ temporary, target: localFile });
        writeFileSync(temporary, buffer, { flag: "wx" });
        if (file.mode && process.platform !== "win32") chmodSync(temporary, file.mode === "100755" ? 0o755 : 0o644);
      } else {
        atomicWrite(localFile, buffer);
      }
      done += 1;
      try { onProgress?.(done, missing.length, `Fetching ${done}/${missing.length} files for ${skillName}`); } catch { /* notification failure must not invalidate a download */ }
    });
    for (const file of staged) renameSync(file.temporary, file.target);
    applyModes();
  } finally {
    for (const file of staged) { try { unlinkSync(file.temporary); } catch { /* committed */ } }
  }

  console.error(
    `[codex-skills-mcp] Skill ${skillName}: downloaded ${missing.length} files in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
  logEvent("info", "download_skill_complete", {
    skill: skillName,
    duration_ms: Date.now() - startedAt,
    detail: `${missing.length} files`,
  });
}

/**
 * Initialize remote caching (just creates the cache dir now)
 */
export async function initRemote(config: Config): Promise<void> {
  if (!existsSync(config.skillsDir)) {
    mkdirSync(config.skillsDir, { recursive: true });
  }
}

/**
 * Fetch the repository-root SKILL.md of the butler skill (00_codex_skills).
 * Single-file fetch with the usual direct→CDN→mirror fallback chain; never
 * materializes the whole library root.
 */
export async function fetchRootSkillMd(config: Config): Promise<string> {
  const res = await fetchRawWithFallback(config, buildSkillRemotePath(config, "SKILL.md"));
  if (!res.ok) {
    throw new Error(`Failed to fetch root SKILL.md: HTTP ${res.status}`);
  }
  return res.text();
}

/** Sidecar recording manifest validation state for conditional polling. */
interface ManifestMeta {
  /** Conditional validators bound to an exact endpoint URL and cached body. */
  validators?: ManifestValidators;
  source?: CacheSource;
  /** Epoch ms of the last freshness validation (poll, successful or not) */
  validatedAt?: number;
}

const MANIFEST_META_FILE = ".codex-skills.manifest.meta.json";

function manifestMetaPath(config: Config): string {
  return join(config.skillsDir, MANIFEST_META_FILE);
}

export function readManifestMeta(config: Config): ManifestMeta {
  try {
    const value = JSON.parse(readFileSync(manifestMetaPath(config), "utf-8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    if (value.source && !sameSource(value.source, config)) return {};
    const validators: ManifestValidators = {};
    for (const endpoint of ["raw", "contents"] as const) {
      const candidate = value.validators?.[endpoint];
      if (!candidate || typeof candidate.url !== "string" ||
          typeof candidate.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.bodySha256)) continue;
      validators[endpoint] = {
        url: candidate.url, bodySha256: candidate.bodySha256,
        etag: typeof candidate.etag === "string" ? candidate.etag : undefined,
        lastModified: typeof candidate.lastModified === "string" ? candidate.lastModified : undefined,
      };
    }
    return {
      validators,
      source: value.source,
      validatedAt: Number.isFinite(value.validatedAt) ? value.validatedAt : undefined,
    };
  } catch {
    return {};
  }
}

function writeManifestMeta(config: Config, meta: ManifestMeta): void {
  try {
    mkdirSync(config.skillsDir, { recursive: true });
    atomicWrite(manifestMetaPath(config), JSON.stringify({ ...meta, source: cacheSource(config) }, null, 2));
  } catch {
    // best-effort
  }
}

/** Only valid same-source bytes may participate in conditional validation. */
function cachedManifest(config: Config): ManifestCacheSnapshot | undefined {
  if (!sameSource(readSourceCache(config), config)) return undefined;
  try {
    const text = readFileSync(config.manifestPath, "utf-8");
    parseManifest(JSON.parse(text));
    // Legacy etag/lastModified fields had no body binding. Upgrade them by
    // requesting one unconditional authoritative response, never by guessing.
    return { text, validators: readManifestMeta(config).validators };
  } catch {
    return undefined;
  }
}

/**
 * Download the manifest file, or refresh it if stale (older than config.manifestTTL).
 * Returns true only after a validated refresh was persisted. Automatic startup
 * may serve a valid same-source cache offline; an explicit refresh reports errors.
 */
export async function fetchManifest(config: Config, force = false): Promise<boolean> {
  const cached = cachedManifest(config);
  if (!force && cached) {
    // Same remote source: honor TTL (0 = never refresh by age).
    if (config.manifestTTL === 0) return false;
    try {
      const mtime = statSync(config.manifestPath).mtimeMs;
      const age = Date.now() - mtime;
      if (age < config.manifestTTL) return false;
      console.error(`[codex-skills-mcp] Manifest is ${Math.round(age / 3600000)}h old, refreshing...`);
    } catch {
      // Can't stat — fall through to re-download
    }
  }
  try {
    await downloadManifest(config, cached);
    return true;
  } catch (error) {
    if (!force && cached) {
      logEvent("warn", "manifest_refresh_failed", {
        error: error instanceof Error ? error.message : String(error),
        detail: "Serving validated same-source manifest cache",
      });
      return false;
    }
    throw error;
  }
}

async function downloadManifest(config: Config, cached?: ManifestCacheSnapshot): Promise<void> {
  console.error("[codex-skills-mcp] Fetching manifest...");
  const result = await fetchRemoteManifest(config, { cached, authoritativeTimeoutMs: 20_000 });
  atomicWrite(config.manifestPath, result.text);
  writeSourceCache(config);
  writeManifestMeta(config, { validators: result.validators, validatedAt: Date.now() });
  logEvent("info", "manifest_refresh", {
    detail: `startup/ttl refresh: ${result.entries.length} skills (${result.source}${result.notModified ? " 304" : ""})`,
  });
  console.error(`[codex-skills-mcp] Manifest refreshed: ${result.entries.length} skills`);
}

/** In-process throttle so concurrent tool calls share one poll window. */
const manifestPollInflight = new Map<string, Promise<boolean>>();
const manifestPollLastAttempt = new Map<string, number>();

/**
 * Throttled conditional freshness check against GitHub raw and Contents
 * endpoints (docs/IMPROVEMENT-MANIFEST-FRESHNESS.md §3). Runs at most once per
 * config.manifestPollMs; 304 → no-op; 200 → replace manifest; failures are
 * silent (search proceeds with the local index). Returns true when the
 * manifest content changed and the search index should be rebuilt.
 */
export async function refreshManifestIfStale(config: Config): Promise<boolean> {
  if (config.manifestPollMs === 0) return false;
  const key = operationKey(config);
  const existing = manifestPollInflight.get(key);
  if (existing) return existing;

  const run = (async (): Promise<boolean> => {
    const sourceMatches = existsSync(config.manifestPath) && sameSource(readSourceCache(config), config);
    const meta = sourceMatches ? readManifestMeta(config) : {};
    const now = Date.now();
    const previousAttempt = Math.max(meta.validatedAt ?? 0, manifestPollLastAttempt.get(key) ?? 0);
    if (previousAttempt && now - previousAttempt < config.manifestPollMs) {
      return false; // validated recently — stay silent
    }
    manifestPollLastAttempt.set(key, now);
    const cached = cachedManifest(config);

    try {
      logEvent("info", "manifest_poll", { detail: "authoritative conditional refresh" });
      const result = await fetchRemoteManifest(config, {
        cached, authoritativeTimeoutMs: 4_000, allowMirrors: false,
      });
      const changed = cached?.text !== result.text;
      if (changed) atomicWrite(config.manifestPath, result.text);
      writeSourceCache(config);
      writeManifestMeta(config, { validators: result.validators, validatedAt: Date.now() });
      logEvent("info", "manifest_refresh", {
        detail: `poll: ${result.entries.length} skills (${result.source} ${result.notModified ? "304" : "200"})`,
      });
      if (changed) console.error(`[codex-skills-mcp] Manifest refreshed via poll: ${result.entries.length} skills`);
      return changed;
    } catch (err) {
      // Throttle failures without attaching a new source to an old cache.
      if (cached) writeManifestMeta(config, { ...meta, validatedAt: Date.now() });
      logEvent("warn", "manifest_poll_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  })();

  manifestPollInflight.set(key, run);
  try {
    return await run;
  } finally {
    manifestPollInflight.delete(key);
  }
}

/** Per-skill fetch deduplication: prevents concurrent downloads of the same skill */
const inflightFetches = new Map<string, Promise<void>>();

/** In-memory backoff (10 min) after a failed revalidation: serve stale instead of hammering a dead network on every read. */
const revalidateBackoff = new Map<string, number>();
const REVALIDATE_BACKOFF_MS = 10 * 60 * 1000;

function inRevalidateBackoff(relPath: string): boolean {
  const until = revalidateBackoff.get(relPath);
  if (until && Date.now() < until) return true;
  revalidateBackoff.delete(relPath);
  return false;
}

/**
 * Whether a completed skill's tree cache may be served without contacting the
 * remote. `manifestTTL === 0` disables revalidation entirely (legacy
 * never-revalidate behavior, zero overhead). Legacy entries without
 * `validatedAt` use `completedAt` as a one-time anchor.
 */
function matchesFileIndex(cached: SkillTreeCache, entry: ManifestEntry): boolean {
  return cached.fileIndexSha256 === entry.file_index?.sha256;
}

function revalidationKey(config: Config, entry: ManifestEntry): string {
  return operationKey(config, `${relativePath(entry.relative_path)}:${entry.file_index?.sha256 ?? "legacy"}`);
}

function recordCatalogValidation(config: Config, entry: ManifestEntry, tree: SkillTreeCache): void {
  if (matchesFileIndex(tree, entry)) revalidateBackoff.delete(revalidationKey(config, entry));
  else revalidateBackoff.set(revalidationKey(config, entry), Date.now() + REVALIDATE_BACKOFF_MS);
}

function isTreeValidationFresh(cached: SkillTreeCache, config: Config, entry: ManifestEntry): boolean {
  // A new manifest is an explicit content revision, even when time-based
  // polling is disabled. Legacy markers migrate on their next read.
  if (!matchesFileIndex(cached, entry)) return false;
  if (config.manifestTTL === 0) return true;
  if (inRevalidateBackoff(revalidationKey(config, entry))) return true;
  const anchor = cached.validatedAt ?? cached.completedAt ?? null;
  if (!anchor) return false;
  const age = Date.now() - Date.parse(anchor);
  return Number.isFinite(age) && age <= config.manifestTTL;
}

/**
 * Re-list the skill's remote tree (category cache first — 2 conditional API
 * calls per category per TTL window, shared by every skill in it) and sync:
 * download new/size-changed/sha-changed files, remove upstream-deleted ones,
 * then rewrite the tree marker with fresh shas and a new validatedAt.
 * Degrades gracefully: on any failure the cached version is served and a
 * 10-minute backoff suppresses retry storms.
 */
async function revalidateSkillTree(
  config: Config,
  entry: ManifestEntry,
  relPath: string,
  skillLocalPath: string,
  cacheFile: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const skillName = basename(skillLocalPath);
  try {
    const remote =
      (await fetchSkillTreeFromFileIndex(config, entry)) ??
      (await fetchSkillTreeFromCategory(config, entry)) ??
      (await fetchSkillTree(config, relPath));
    if (!remote.files || remote.files.length === 0) {
      throw new Error("remote tree returned no files");
    }
    if (!validFiles(remote.files)) throw new Error("Invalid remote file tree");
    const remoteTree: SkillTreeCache = { ...remote, source: cacheSource(config) };

    const old = readTree(cacheFile);
    const oldFiles = old && sameSource(old.source, config) ? old.files : [];
    const oldByPath = new Map(oldFiles.map((f) => [f.path, f]));
    const remotePaths = new Set(remoteTree.files.map((f) => f.path));
    const changedPaths = new Set<string>();
    for (const file of remoteTree.files) {
      const previous = oldByPath.get(file.path);
      if (!previous || previous.size !== file.size || (file.sha && file.sha !== previous.sha)) {
        changedPaths.add(file.path);
      }
    }
    const removedPaths = oldFiles.filter((file) => !remotePaths.has(file.path))
      .map((file) => localFilePath(skillLocalPath, file.path));
    // Stage the entire update first. A failed transfer leaves all old files and
    // the old marker usable, including upstream-deleted files.
    await downloadMissing(config, relPath, remoteTree, skillLocalPath, onProgress, {
      force: changedPaths, transactional: true,
    });
    let removed = 0;
    for (const local of removedPaths) {
      if (existsSync(local)) { unlinkSync(local); removed++; }
    }
    const changed = changedPaths.size;

    const now = new Date().toISOString();
    atomicWrite(cacheFile, JSON.stringify({ ...remoteTree, completedAt: now, validatedAt: now }, null, 2));
    recordCatalogValidation(config, entry, remoteTree);

    if (changed > 0 || removed > 0) {
      logEvent("info", "skill_revalidated", {
        skill: skillName,
        detail: JSON.stringify({ changed, removed }),
      });
      console.error(
        `[codex-skills-mcp] Skill "${skillName}" updated from remote: ${changed} file(s) changed, ${removed} removed`
      );
    }
  } catch (error: any) {
    revalidateBackoff.set(revalidationKey(config, entry), Date.now() + REVALIDATE_BACKOFF_MS);
    console.error(
      `[codex-skills-mcp] Tree revalidation failed for "${skillName}" (${error?.message ?? error}); serving cached version`
    );
    logEvent("warn", "skill_revalidate_failed", { skill: skillName, error: String(error?.message ?? error) });
  }
}

/** Run `fn` under the per-skill inflight lock (deduplicates concurrent callers). */
async function runExclusively(relPath: string, fn: () => Promise<void>): Promise<void> {
  const existing = inflightFetches.get(relPath);
  if (existing) {
    await existing;
    // Recheck under the lock: a waiting caller may hold a newer manifest.
    return runExclusively(relPath, fn);
  }
  const promise = (async () => {
    try {
      await fn();
    } finally {
      inflightFetches.delete(relPath);
    }
  })();
  inflightFetches.set(relPath, promise);
  await promise;
}

/**
 * Ensure a skill's directory is downloaded and cached.
 *
 * - Listing prefers a verified immutable catalog, then the category-wide
 *   tree cache and per-skill subtree API for legacy sources or failures.
 * - Downloads run concurrently and skip files already cached with the right size.
 * - A `.codex-skills.tree.json` marker records the file list + completion state,
 *   so an interrupted download resumes on the next call instead of being
 *   silently treated as complete.
 * - Completed caches are REVALIDATED against the remote tree once
 *   `manifestTTL` expires: content-level (sha) changes, added files and
 *   upstream deletions are all picked up; `manifestTTL === 0` keeps the
 *   legacy never-revalidate behavior unless the manifest catalog changes.
 * - Concurrent calls for the same skill are deduplicated via a promise lock.
 */
export async function ensureSkillFetched(
  config: Config,
  entry: ManifestEntry,
  onProgress?: ProgressCallback
): Promise<SkillMaterialization> {
  const relPath = relativePath(entry.relative_path);
  const skillLocalPath = localFilePath(config.skillsDir, relPath);
  const cacheFile = localFilePath(skillLocalPath, TREE_CACHE_FILE);
  const key = operationKey(config, relPath);

  const snapshot = readTreeSnapshot(cacheFile);
  const cached = snapshot.tree;
  if (cached && sameSource(cached.source, config) && cached.completedAt &&
      isTreeValidationFresh(cached, config, entry)) {
    const inspected = inspectSkillCache(config, entry, skillLocalPath, snapshot);
    if (inspected.cache.complete && markerIdentity(cacheFile) === snapshot.identity) {
      return materializationReceipt(config, entry, cacheFile, snapshot.identity, inspected);
    }
  }

  await runExclusively(key, async () => {
    beginMaterialization(cacheFile);
    try {
      const current = readTree(cacheFile);
      if (current && sameSource(current.source, config) && current.completedAt) {
        if (isTreeValidationFresh(current, config, entry)) {
          await downloadMissing(config, relPath, current, skillLocalPath, onProgress);
        } else if (!inRevalidateBackoff(revalidationKey(config, entry))) {
          await revalidateSkillTree(config, entry, relPath, skillLocalPath, cacheFile, onProgress);
        }
        return;
      }
      await doFetchSkill(config, entry, relPath, skillLocalPath, cacheFile, onProgress);
    } finally {
      finishMaterialization(cacheFile);
    }
  });
  const completed = readTreeSnapshot(cacheFile);
  const inspected = inspectSkillCache(config, entry, skillLocalPath, completed);
  return materializationReceipt(config, entry, cacheFile, completed.identity, inspected);
}

/** Inner fetch logic, called under the source-scoped deduplication lock. */
async function doFetchSkill(
  config: Config,
  entry: ManifestEntry,
  relPath: string,
  skillLocalPath: string,
  cacheFile: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const cached = readTree(cacheFile);
  if (cached && sameSource(cached.source, config) && matchesFileIndex(cached, entry)) {
    await downloadMissing(config, relPath, cached, skillLocalPath, onProgress, { verifyExisting: true });
    atomicWrite(cacheFile, JSON.stringify({ ...cached, completedAt: new Date().toISOString() }, null, 2));
    return;
  }

  mkdirSync(skillLocalPath, { recursive: true });
  console.error(`[codex-skills-mcp] Listing files for skill: ${entry.name}...`);
  const tree = (await fetchSkillTreeFromFileIndex(config, entry)) ??
    (await fetchSkillTreeFromCategory(config, entry)) ??
    (await fetchSkillTree(config, relPath));
  if (!validFiles(tree.files)) throw new Error("Invalid remote file tree");
  const treeWithSource = { ...tree, source: cacheSource(config) };
  // A different source can have same-size files. Never treat them as a resume.
  const sourceChanged = !!cached && (!sameSource(cached.source, config) || !matchesFileIndex(cached, entry));
  const currentPaths = new Set(tree.files.map((file) => file.path));
  const obsoletePaths = sourceChanged ? cached.files.filter((file) => !currentPaths.has(file.path))
    .map((file) => localFilePath(skillLocalPath, file.path)) : [];
  if (!sourceChanged) atomicWrite(cacheFile, JSON.stringify(treeWithSource, null, 2));
  await downloadMissing(config, relPath, tree, skillLocalPath, onProgress, {
    force: new Set(tree.files.map((file) => file.path)),
    transactional: sourceChanged,
  });
  for (const obsolete of obsoletePaths) if (existsSync(obsolete)) unlinkSync(obsolete);
  atomicWrite(cacheFile, JSON.stringify({ ...treeWithSource, completedAt: new Date().toISOString() }, null, 2));
  recordCatalogValidation(config, entry, treeWithSource);
}

/** Deep cache-state report for one skill (see docs/IMPROVEMENT-PLAN.md §5). */
export interface SkillCacheState {
  /** A tree marker exists: at least one download attempt happened */
  cached: boolean;
  /** Marker says complete AND every recorded file is present with expected size */
  complete: boolean;
  localPath: string;
  filesTotal: number;
  filesMissing: string[];
  /** Expected total size in bytes (sum of the recorded tree) */
  sizeBytes: number;
  completedAt?: string;
  /** Whether cached content is tied to the manifest catalog, when present. */
  catalogCurrent?: boolean;
}

export interface SkillMaterializedFile {
  path: string;
  size: number;
  sha?: string;
  mode?: string;
}

/** A single-use receipt. Only this module can create an accepted instance. */
export interface SkillMaterialization {
  readonly kind: "skill-materialization";
}

/** Checked state and its matching marker file list for the current read. */
export interface MaterializedSkillState {
  cache: SkillCacheState;
  files: readonly Readonly<SkillMaterializedFile>[];
}

interface TreeSnapshot {
  tree: SkillTreeCache | null;
  identity?: string;
}

interface MaterializationBinding {
  key: string;
  cacheFile: string;
  marker?: string;
  epoch: symbol;
  inspected: MaterializedSkillState;
}

const materializationReceipts = new WeakMap<SkillMaterialization, MaterializationBinding>();
// Epochs invalidate receipts during repairs even if the marker is unchanged.
// They are not a cache of trusted file states, and evicting one invalidates its receipts.
const materializationEpochs = new Map<string, symbol>();
const activeMaterializations = new Map<string, number>();
const MAX_MATERIALIZATION_EPOCHS = 128;

function advanceMaterializationEpoch(cacheFile: string): symbol {
  const epoch = Symbol();
  materializationEpochs.delete(cacheFile);
  materializationEpochs.set(cacheFile, epoch);
  while (materializationEpochs.size > MAX_MATERIALIZATION_EPOCHS) {
    materializationEpochs.delete(materializationEpochs.keys().next().value!);
  }
  return epoch;
}

function beginMaterialization(cacheFile: string): void {
  advanceMaterializationEpoch(cacheFile);
  activeMaterializations.set(cacheFile, (activeMaterializations.get(cacheFile) ?? 0) + 1);
}

function finishMaterialization(cacheFile: string): void {
  advanceMaterializationEpoch(cacheFile);
  const active = (activeMaterializations.get(cacheFile) ?? 1) - 1;
  if (active) activeMaterializations.set(cacheFile, active);
  else activeMaterializations.delete(cacheFile);
}

function markerIdentity(cacheFile: string): string | undefined {
  try {
    const stat = lstatSync(cacheFile, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch { return undefined; }
}

function readTreeSnapshot(cacheFile: string): TreeSnapshot {
  const before = markerIdentity(cacheFile);
  if (!before) return { tree: null };
  const tree = readTree(cacheFile);
  const after = markerIdentity(cacheFile);
  return before === after ? { tree, identity: after } : { tree: null };
}

function materializationReceipt(
  config: Config, entry: ManifestEntry, cacheFile: string,
  marker: string | undefined, inspected: MaterializedSkillState,
): SkillMaterialization {
  const receipt = Object.freeze({ kind: "skill-materialization" as const });
  materializationReceipts.set(receipt, {
    key: revalidationKey(config, entry), cacheFile, marker, inspected,
    epoch: materializationEpochs.get(cacheFile) ?? advanceMaterializationEpoch(cacheFile),
  });
  return receipt;
}

/**
 * Consume only within the same read that called ensureSkillFetched. Every new
 * request still runs ensure/deep inspection; never store receipts on a loader.
 * A mismatch or a second use returns undefined so callers can deep-check again.
 */
export function consumeSkillMaterialization(
  config: Config, entry: ManifestEntry, receipt: SkillMaterialization | undefined,
): MaterializedSkillState | undefined {
  if (!receipt) return undefined;
  const inspected = peekSkillMaterialization(config, entry, receipt);
  materializationReceipts.delete(receipt);
  return inspected;
}

/** Inspect before asynchronous reads; consume afterwards to detect invalidation. */
export function peekSkillMaterialization(
  config: Config, entry: ManifestEntry, receipt: SkillMaterialization | undefined,
): MaterializedSkillState | undefined {
  if (!receipt) return undefined;
  const binding = materializationReceipts.get(receipt);
  try {
    if (!binding || binding.key !== revalidationKey(config, entry) ||
        materializationEpochs.get(binding.cacheFile) !== binding.epoch ||
        activeMaterializations.has(binding.cacheFile)) return undefined;
    const localPath = localFilePath(config.skillsDir, relativePath(entry.relative_path));
    const cacheFile = localFilePath(localPath, TREE_CACHE_FILE);
    if (cacheFile !== binding.cacheFile || markerIdentity(cacheFile) !== binding.marker) return undefined;
    return binding.inspected;
  } catch { return undefined; }
}

function inspectSkillCache(
  config: Config, entry: ManifestEntry, localPath: string, snapshot: TreeSnapshot,
): MaterializedSkillState {
  const base: SkillCacheState = {
    cached: false, complete: false, localPath, filesTotal: 0, filesMissing: [], sizeBytes: 0,
    catalogCurrent: entry.file_index ? false : undefined,
  };
  const cached = snapshot.tree;
  if (!cached) return { cache: base, files: [] };
  try {
    const filesMissing = cached.files
      .filter((f) => !isFileUpToDate(localFilePath(localPath, f.path), f.size, f.mode))
      .map((f) => f.path);
    if (markerIdentity(join(localPath, TREE_CACHE_FILE)) !== snapshot.identity) return { cache: base, files: [] };
    return {
      cache: {
        cached: true,
        complete: !!cached.completedAt && sameSource(cached.source, config) &&
          matchesFileIndex(cached, entry) && filesMissing.length === 0,
        localPath, filesTotal: cached.files.length, filesMissing,
        sizeBytes: cached.files.reduce((sum, file) => sum + file.size, 0),
        completedAt: cached.completedAt,
        catalogCurrent: entry.file_index ? matchesFileIndex(cached, entry) : undefined,
      },
      files: cached.files.map((file) => Object.freeze({ ...file })),
    };
  } catch { return { cache: base, files: [] }; }
}

/**
 * Deep check: read the skill's .codex-skills.tree.json marker and verify every
 * recorded file exists locally with the expected size. Read-only — never
 * triggers a download.
 */
export function readSkillCacheState(config: Config, entry: ManifestEntry): SkillCacheState {
  const relPath = relativePath(entry.relative_path);
  const localPath = localFilePath(config.skillsDir, relPath);
  const cacheFile = join(localPath, TREE_CACHE_FILE);
  return inspectSkillCache(config, entry, localPath, readTreeSnapshot(cacheFile)).cache;
}

/**
 * Light check (no per-file stats): marker exists, belongs to the current
 * remote source and records a completed download. Used for [cached] badges.
 */
export function isSkillCachedLight(config: Config, entry: ManifestEntry): boolean {
  const relPath = relativePath(entry.relative_path);
  const cacheFile = localFilePath(localFilePath(config.skillsDir, relPath), TREE_CACHE_FILE);
  if (!existsSync(cacheFile)) return false;
  try {
    const cached = readTree(cacheFile);
    return !!cached && (
      !!cached.completedAt &&
      Array.isArray(cached.files) &&
      cached.files.length > 0 &&
      sameSource(cached.source, config) &&
      matchesFileIndex(cached, entry)
    );
  } catch {
    return false;
  }
}
