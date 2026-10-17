import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, extname, basename, dirname, isAbsolute, sep } from "node:path";
import type { ManifestEntry, Config } from "../config.js";
import type { ProgressCallback, SkillMaterialization } from "../remote/github.js";
import { readSkillCacheState, isSkillCachedLight, consumeSkillMaterialization, peekSkillMaterialization, type SkillCacheState } from "../remote/github.js";
import { resolveWithin } from "../lib/paths.js";
import { parse as parseYaml } from "yaml";
import { readSkillDownloadProgress } from "../remote/skill-progress.js";

export interface SkillStructure {
  files: FileNode[];
  sub_skills: SubSkillInfo[];
}

export interface FileNode {
  name: string;
  type: "file" | "directory";
  size_bytes?: number;
  children?: FileNode[];
}

export interface SubSkillInfo {
  name: string;
  path: string;
  description: string;
}

export interface SkillDependencies {
  language: string;
  package_manager?: string;
  setup_command?: string;
}

export interface ReadSkillResult {
  instructions: string;
  structure: SkillStructure;
  dependencies: SkillDependencies;
  /** The state verified by this materialization, reused by the tool response. */
  cache?: SkillCacheState;
  /** Shared with readNavigation; excludes credentials and pagination filters. */
  navigationIdentity: string;
}

export interface ClearSkillCacheResult {
  found: boolean;
  cleared: boolean;
  local_path: string;
  files_removed: number;
  bytes_removed: number;
}

export interface SkillNavigationOptions {
  view: "files" | "sub_skills";
  path?: string;
  /** File-tree depth only; subskill discovery always covers the whole subtree. */
  maxDepth?: number;
}

export interface SkillNavigationResult extends SkillStructure {
  identity: string;
  cache: SkillCacheState;
}

interface StructureOptions {
  view?: SkillNavigationOptions["view"];
  path?: string;
}

export interface ReadInstructionsResult {
  instructions: string;
  cache: SkillCacheState;
}

export interface SkillFileReadOptions {
  /** Zero-based UTF-8 byte offset. A split code point is snapped backward. */
  offset?: number;
  /** Positive chunk size bounded by the loader before reading. */
  maxBytes?: number;
}

export interface SkillFileReadResult {
  content: string;
  size_bytes: number;
  offset: number;
  bytes_returned: number;
  next_offset?: number;
  has_more: boolean;
  binary: boolean;
  mime_type?: string;
}

export interface SkillImagePreviewResult {
  mime_type: string;
  size_bytes: number;
  data_base64: string;
}

interface CatalogFile {
  path: string;
  size: number;
  sha?: string;
  mode?: string;
  /** Includes inode, size and local change timestamps from this request. */
  fingerprint?: string;
}

// Files/dirs to skip when scanning structure
const SKIP_NAMES = new Set([
  "node_modules", ".git", ".github", "__pycache__",
  ".DS_Store", ".env", ".venv", "venv",
  "dist", "build", ".next", ".cache",
]);

// These directories may contain valid fixture/example SKILL.md files, but they
// are not callable product skills. Keep them available in the file tree while
// excluding them from automatic sub-skill discovery.
const SKIP_SUBSKILL_DIRS = new Set([
  "benchmark", "benchmarks",
  "eval", "evals",
  "example", "examples",
  "fixture", "fixtures",
  "test", "tests",
]);

// Default bytes returned by one load_skill_file call. Larger text files use
// explicit byte offsets so callers never need to reload the whole file.
const DEFAULT_FILE_CHUNK_BYTES = 500 * 1024;
const MIN_FILE_CHUNK_BYTES = 1024;
const MAX_FILE_CHUNK_BYTES = 2 * 1024 * 1024;
const BINARY_MIME_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".heic": "image/heic", ".bmp": "image/bmp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".zip": "application/zip", ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
  ".tar": "application/x-tar", ".gz": "application/gzip", ".xz": "application/x-xz",
  ".pdf": "application/pdf", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pps": "application/vnd.ms-powerpoint", ".ppsx": "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation", ".epub": "application/epub+zip",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4",
  ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  ".webm": "video/webm", ".psd": "image/vnd.adobe.photoshop", ".wasm": "application/wasm",
  ".exe": "application/vnd.microsoft.portable-executable", ".dll": "application/vnd.microsoft.portable-executable",
  ".so": "application/x-sharedlib", ".dylib": "application/x-mach-binary",
  ".sqlite": "application/vnd.sqlite3", ".sqlite3": "application/vnd.sqlite3",
  ".parquet": "application/vnd.apache.parquet", ".arrow": "application/vnd.apache.arrow.file",
};
const BROWSER_PREVIEW_IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon", "image/avif",
]);
const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const SUMMARY_CACHE_ENTRIES = 8192;
const SUMMARY_CACHE_BYTES = 4 * 1024 * 1024;

/** A shared per-loader permit pool also bounds concurrent resource requests. */
class FileReadPool {
  private active = 0;
  private waiting: (() => void)[] = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < 8) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try { return await operation(); } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readUtf8FileChunk(path: string, size: number, requestedOffset: number, maxBytes: number): SkillFileReadResult {
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > size) {
    throw new Error(`File offset must be an integer from 0 to ${size}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_FILE_CHUNK_BYTES || maxBytes > MAX_FILE_CHUNK_BYTES) {
    throw new Error(`max_bytes must be an integer from ${MIN_FILE_CHUNK_BYTES} to ${MAX_FILE_CHUNK_BYTES}`);
  }
  // Read a few surrounding bytes so a caller that lands inside a UTF-8
  // sequence can be snapped backward without reading the whole file.
  const prefix = Math.min(3, requestedOffset);
  const readStart = requestedOffset - prefix;
  const desiredEnd = Math.min(size, requestedOffset + maxBytes);
  const readLength = Math.min(size - readStart, desiredEnd - readStart + 3);
  const buffer = Buffer.allocUnsafe(readLength);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < readLength) {
      const count = readSync(fd, buffer, read, readLength - read, readStart + read);
      if (count === 0) break;
      read += count;
    }
    if (read !== readLength) throw new Error(`Short read for ${path}`);
  } finally {
    closeSync(fd);
  }

  let start = prefix;
  while (start > 0 && (buffer[start] & 0xc0) === 0x80) start--;
  let end = desiredEnd - readStart;
  // If the exclusive end lands inside a multi-byte sequence, exclude that
  // complete character. The next offset points to its first byte, so repeated
  // calls neither split UTF-8 nor drop content.
  while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  const content = buffer.subarray(start, end).toString("utf8");
  const offset = readStart + start;
  const next = readStart + end;
  return {
    content,
    size_bytes: size,
    offset,
    bytes_returned: end - start,
    ...(next < size ? { next_offset: next } : {}),
    has_more: next < size,
    binary: false,
  };
}

function looksBinary(path: string, size: number): boolean {
  if (size === 0) return false;
  const sampleSize = Math.min(size, 8192);
  const sample = Buffer.allocUnsafe(sampleSize);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, sample, 0, sampleSize, 0);
    let controls = 0;
    for (let index = 0; index < read; index++) {
      const byte = sample[index];
      if (byte === 0) return true;
      if (byte < 9 || (byte > 13 && byte < 32)) controls++;
    }
    return read > 0 && controls / read > 0.05;
  } finally {
    closeSync(fd);
  }
}

function metadataSummary(content: string): Record<string, unknown> | null {
  // Parse only the opening YAML front matter. Searching the whole document
  // made body headings and examples look like metadata.
  const match = /^---\r?\n([\S\s]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  try {
    const value = parseYaml(match[1]);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/[\r\n\t ]+/g, " ").trim() : null;
}

function summary(content: string, folder: string): Pick<SubSkillInfo, "name" | "description"> {
  const metadata = metadataSummary(content);
  const name = scalar(metadata?.name) ?? folder;
  const description = scalar(metadata?.description) ?? "";
  // Copy parsed strings so a cache entry cannot retain a whole SKILL.md through
  // a large V8 substring backing buffer.
  return { name: Buffer.from(name).toString(), description: Buffer.from(description).toString() };
}

/**
 * Skill loader — reads SKILL.md, scans structure, detects dependencies.
 */
export class SkillLoader {
  private skillsDir: string;
  private readonly fileReads = new FileReadPool();
  private readonly summaries = new Map<string, { value: Pick<SubSkillInfo, "name" | "description">; bytes: number }>();
  private summaryBytes = 0;
  private _ensureSkillFetched:
    | ((config: Config, entry: ManifestEntry, onProgress?: ProgressCallback) => Promise<SkillMaterialization>)
    | null = null;

  constructor(
    private config: Config,
    private manifest: ManifestEntry[]
  ) {
    this.skillsDir = config.skillsDir;
  }

  /** Download deadline settings for the tool layer (read_skill etc.). */
  get downloadDeadlines(): { softDeadlineMs: number; hardDeadlineMs: number } {
    return {
      softDeadlineMs: this.config.softDeadlineMs,
      hardDeadlineMs: this.config.hardDeadlineMs,
    };
  }

  get cacheMode(): "remote" | "local" {
    return this.config.isRemote ? "remote" : "local";
  }

  /** Lazy-load remote module only when needed */
  private async ensureRemoteFetched(
    entry: ManifestEntry,
    onProgress?: ProgressCallback
  ): Promise<SkillMaterialization> {
    if (!this._ensureSkillFetched) {
      const { ensureSkillFetched } = await import("../remote/github.js");
      this._ensureSkillFetched = ensureSkillFetched;
    }
    return this._ensureSkillFetched(this.config, entry, onProgress);
  }

  /**
   * Resolve the absolute filesystem path for a skill.
   */
  resolveSkillPath(entry: ManifestEntry): string {
    // relative_path starts with "./" and is relative to the manifest dir
    const relPath = entry.relative_path.replace(/^\.\//, "");
    return resolveWithin(this.skillsDir, relPath);
  }

  /**
   * Read instructions after the same complete materialization used by
   * readSkill. Resource previews do not need a directory or dependency scan.
   */
  async readInstructions(entry: ManifestEntry, onProgress?: ProgressCallback): Promise<string> {
    return (await this.readInstructionsWithState(entry, onProgress)).instructions;
  }

  async readInstructionsWithState(entry: ManifestEntry, onProgress?: ProgressCallback): Promise<ReadInstructionsResult> {
    const { instructions, cache } = await this.readMaterialized(entry, false, onProgress);
    return { instructions, cache };
  }

  /**
   * Read a skill's SKILL.md + structure + dependencies.
   */
  async readSkill(entry: ManifestEntry, onProgress?: ProgressCallback): Promise<ReadSkillResult> {
    return this.readMaterialized(entry, true, onProgress);
  }

  /** Read one navigation view without reading root instructions or dependencies. */
  async readNavigation(entry: ManifestEntry, options: SkillNavigationOptions): Promise<SkillNavigationResult> {
    if (options.view !== "files" && options.view !== "sub_skills") throw new Error("Invalid navigation view");
    const maxDepth = options.maxDepth ?? 2;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 8) throw new Error("maxDepth must be an integer from 0 to 8");
    const skillPath = this.resolveSkillPath(entry);
    // Reject traversal before starting any remote materialization. Resolving
    // again after it completes also checks newly created symlink ancestors.
    const normalized = relative(skillPath, resolveWithin(skillPath, options.path ?? "")).split(sep).join("/");
    const selection: StructureOptions = { view: options.view, path: normalized };
    if (!this.config.isRemote) {
      await this.requireNavigationDirectory(skillPath, normalized);
      const structure = await this.localStructure(skillPath, maxDepth, selection);
      return { ...structure, cache: this.cacheState(entry), identity: this.navigationIdentity(entry, skillPath) };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const receipt = await this.ensureRemoteFetched(entry);
      const prepared = peekSkillMaterialization(this.config, entry, receipt);
      if (!prepared) continue;
      await this.requireNavigationDirectory(prepared.cache.localPath, normalized);
      const structure = prepared.cache.complete
        ? await this.catalogStructure(prepared.cache.localPath, prepared.files, this.summarySourceKey(prepared.cache.localPath), maxDepth, selection)
        : await this.localStructure(prepared.cache.localPath, maxDepth, selection);
      const verified = consumeSkillMaterialization(this.config, entry, receipt);
      if (verified) return { ...structure, cache: verified.cache,
        identity: this.navigationIdentity(entry, verified.cache.localPath, verified.files) };
    }
    throw new Error("Skill cache changed during the read. Retry to read a consistent materialization.");
  }

  private async requireNavigationDirectory(skillPath: string, path: string): Promise<void> {
    const target = resolveWithin(skillPath, path);
    let info;
    try { info = await this.fileReads.run(() => stat(target)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Path not found: ${path || "."}`);
      throw error;
    }
    if (!info.isDirectory()) throw new Error(`Path is not a directory: ${path}`);
  }

  private summarySourceKey(skillPath: string): string {
    return JSON.stringify([skillPath, this.config.githubRepo, this.config.githubBranch, this.config.githubPath]);
  }

  private navigationIdentity(entry: ManifestEntry, skillPath: string, files?: readonly CatalogFile[]): string {
    const actualRevision = files ? createHash("sha256") : undefined;
    if (files) {
      for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
        actualRevision!.update(JSON.stringify([file.path, file.size, file.sha ?? null, file.mode ?? null]) + "\n");
      }
    }
    // The paging layer additionally hashes all returned rows, so local edits
    // invalidate cursors without retaining snapshots or tokens in the loader.
    return createHash("sha256").update(JSON.stringify([
      "skill-navigation-v1", resolve(this.skillsDir), resolve(this.config.manifestPath),
      resolve(skillPath), entry.name, this.config.isRemote,
      this.config.isRemote ? [this.config.githubRepo, this.config.githubBranch, this.config.githubPath] : null,
      entry.file_index?.sha256 ?? null, actualRevision?.digest("hex") ?? "local",
    ])).digest("hex");
  }

  private async rootInstructions(skillPath: string, entry: ManifestEntry): Promise<string> {
    const target = resolveWithin(skillPath, "SKILL.md");
    try { return await this.fileReads.run(() => readFile(target, "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`SKILL.md not found for ${entry.name}`);
      throw error;
    }
  }

  private async readMaterialized(
    entry: ManifestEntry, includeStructure: boolean, onProgress?: ProgressCallback
  ): Promise<ReadSkillResult & { cache: SkillCacheState }> {
    const empty = (): SkillStructure => ({ files: [], sub_skills: [] });
    if (!this.config.isRemote) {
      const skillPath = this.resolveSkillPath(entry);
      const instructions = await this.rootInstructions(skillPath, entry);
      const structure = includeStructure ? await this.localStructure(skillPath) : empty();
      const dependencies = includeStructure ? this.detectDependencies(skillPath) : { language: "markdown-only" };
      return { instructions, structure, dependencies, cache: this.cacheState(entry),
        navigationIdentity: includeStructure ? this.navigationIdentity(entry, skillPath) : "" };
    }
    // Asynchronous file reads can overlap a repair or source change. Inspect
    // the receipt first, but consume it only after the entire response is read.
    for (let attempt = 0; attempt < 2; attempt++) {
      const receipt = await this.ensureRemoteFetched(entry, onProgress);
      const prepared = peekSkillMaterialization(this.config, entry, receipt);
      if (!prepared) continue;
      const skillPath = prepared.cache.localPath;
      const sourceKey = this.summarySourceKey(skillPath);
      const instructions = await this.rootInstructions(skillPath, entry);
      const structure = includeStructure
        ? prepared.cache.complete
          ? await this.catalogStructure(skillPath, prepared.files, sourceKey)
          : await this.localStructure(skillPath)
        : empty();
      const dependencies = includeStructure ? this.detectDependencies(skillPath) : { language: "markdown-only" };
      const verified = consumeSkillMaterialization(this.config, entry, receipt);
      if (verified) return { instructions, structure, dependencies, cache: verified.cache,
        navigationIdentity: includeStructure ? this.navigationIdentity(entry, skillPath, verified.files) : "" };
    }
    throw new Error("Skill cache changed during the read. Retry to read a consistent materialization.");
  }

  /** Build only the displayed tree from an already validated materialization. */
  private async catalogStructure(
    skillPath: string, files: readonly CatalogFile[], sourceKey: string, maxDepth = 2, options: StructureOptions = {}
  ): Promise<SkillStructure> {
    type Tree = Map<string, FileNode & { entries?: Tree }>;
    const tree: Tree = new Map();
    const candidates: CatalogFile[] = [];
    const includeFiles = options.view !== "sub_skills";
    const includeSkills = options.view !== "files";
    const prefix = options.path ? `${options.path}/` : "";
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (prefix && !file.path.startsWith(prefix)) continue;
      const parts = file.path.slice(prefix.length).split("/");
      const parents = parts.slice(0, -1);
      // Hidden subskills are discoverable at every depth. A selected subtree
      // includes its own SKILL.md, while the library skill root is excluded.
      if (includeSkills && parts.at(-1) === "SKILL.md" && (parents.length > 0 || !!prefix) &&
          parents.every((name) => !SKIP_NAMES.has(name) && !SKIP_SUBSKILL_DIRS.has(name))) {
        candidates.push(file);
      }

      let current = tree;
      for (let depth = 0; includeFiles && depth < parts.length && depth <= maxDepth; depth++) {
        const name = parts[depth];
        if (SKIP_NAMES.has(name) || (name.startsWith(".") && name !== ".env.example")) break;
        if (depth === parts.length - 1) {
          current.set(name, { name, type: "file", size_bytes: file.size });
        } else {
          let node = current.get(name);
          if (!node) {
            node = { name, type: "directory", ...(depth < maxDepth ? { entries: new Map() } : {}) };
            current.set(name, node);
          }
          if (!node.entries) break;
          current = node.entries;
        }
      }
      if ((index + 1) % 256 === 0) await yieldToEventLoop();
    }
    const toNodes = (entries: Tree): FileNode[] => [...entries.values()]
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map(({ entries: children, ...node }) => children ? { ...node, children: toNodes(children) } : node);
    // A lexical path-segment comparison preserves depth-first directory order
    // even when the catalog itself is not sorted.
    candidates.sort((a, b) => {
      const left = a.path.split("/").slice(0, -1);
      const right = b.path.split("/").slice(0, -1);
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
      }
      return left.length - right.length;
    });
    const root = candidates.length ? await this.fileReads.run(() => realpath(skillPath)) : skillPath;
    const subSkills = await Promise.all(candidates.map((file) => this.catalogSummary(root, file, sourceKey)));
    return { files: toNodes(tree), sub_skills: subSkills.filter((item): item is SubSkillInfo => item !== null) };
  }

  private cacheSummary(key: string, value: Pick<SubSkillInfo, "name" | "description">): void {
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(value.name) + Buffer.byteLength(value.description);
    if (bytes > SUMMARY_CACHE_BYTES) return;
    const previous = this.summaries.get(key);
    if (previous) {
      this.summaryBytes -= previous.bytes;
      this.summaries.delete(key);
    }
    this.summaries.set(key, { value, bytes });
    this.summaryBytes += bytes;
    while (this.summaries.size > SUMMARY_CACHE_ENTRIES || this.summaryBytes > SUMMARY_CACHE_BYTES) {
      const oldest = this.summaries.keys().next().value!;
      this.summaryBytes -= this.summaries.get(oldest)!.bytes;
      this.summaries.delete(oldest);
    }
  }

  private async catalogSummary(skillPath: string, file: CatalogFile, sourceKey: string): Promise<SubSkillInfo | null> {
    const path = dirname(file.path);
    // Legacy tree entries without a content identity still work, but do not
    // enter the cache. A local edit invalidates even a same-size catalog file.
    try {
      let fingerprint = file.fingerprint;
      if (!fingerprint && file.sha) {
        const local = await this.fileReads.run(() => stat(join(skillPath, file.path), { bigint: true }));
        fingerprint = [local.dev, local.ino, local.size, local.mtimeNs, local.ctimeNs].join(":");
      }
      const key = file.sha && fingerprint ? JSON.stringify([sourceKey, file.path, file.sha, fingerprint]) : undefined;
      if (key) {
        const cached = this.summaries.get(key);
        if (cached) {
          this.summaries.delete(key);
          this.summaries.set(key, cached);
          return { ...cached.value, path };
        }
      }
      // Re-resolve before asynchronous reads too: a file may have changed since
      // the materialization snapshot checked its ancestors.
      const target = await this.fileReads.run(() => realpath(join(skillPath, file.path)));
      if (!contained(skillPath, target)) return null;
      const content = await this.fileReads.run(() => readFile(target, "utf8"));
      const value = summary(content, basename(path));
      if (key) this.cacheSummary(key, value);
      return { ...value, path };
    } catch {
      // Match the old scanner's handling of files removed during a read.
      return null;
    }
  }

  /** Local checkouts remain editable: inspect the actual tree on every read. */
  private async localStructure(skillPath: string, maxDepth = 2, options: StructureOptions = {}): Promise<SkillStructure> {
    const root = await this.fileReads.run(() => realpath(skillPath));
    const start = await this.fileReads.run(() => realpath(resolveWithin(skillPath, options.path ?? "")));
    if (!contained(root, start)) throw new Error("Path traversal detected: symlink leaves its directory");
    const includeFiles = options.view !== "sub_skills";
    const includeSkills = options.view !== "files";
    const sourceKey = this.summarySourceKey(root);
    const readSummary = async (directory: string): Promise<SubSkillInfo | null> => {
      try {
        const target = await this.fileReads.run(() => realpath(join(directory, "SKILL.md")));
        if (!contained(root, target)) return null;
        const before = await this.fileReads.run(() => stat(target, { bigint: true }));
        const key = JSON.stringify([sourceKey, target, before.dev.toString(), before.ino.toString(), before.size.toString(), before.mtimeNs.toString(), before.ctimeNs.toString()]);
        const cached = this.summaries.get(key);
        if (cached) {
          this.summaries.delete(key);
          this.summaries.set(key, cached);
          return { ...cached.value, path: relative(root, directory).split(sep).join("/") };
        }
        const content = await this.fileReads.run(() => readFile(target, "utf8"));
        const value = summary(content, basename(directory));
        // If metadata changed while reading, do not cache under the old key; the
        // next scan must read the edited bytes.
        const after = await this.fileReads.run(() => stat(target, { bigint: true }));
        if (after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs &&
            after.size === before.size) this.cacheSummary(key, value);
        return { ...value, path: relative(root, directory).split(sep).join("/") };
      } catch { return null; }
    };
    const walk = async (
      directory: string,
      depth: number,
      visible: boolean,
      discoverSubSkills: boolean,
    ): Promise<SkillStructure> => {
      try {
        const canonical = await this.fileReads.run(() => realpath(directory));
        if (!contained(root, canonical)) return { files: [], sub_skills: [] };
        const entries = (await this.fileReads.run(() => readdir(canonical, { withFileTypes: true })))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const results = await Promise.all(entries.map(async (entry): Promise<SkillStructure> => {
          if (SKIP_NAMES.has(entry.name)) return { files: [], sub_skills: [] };
          const show = includeFiles && visible && (!entry.name.startsWith(".") || entry.name === ".env.example");
          if (entry.isDirectory()) {
            const child = join(canonical, entry.name);
            const childDiscoversSubSkills =
              discoverSubSkills && !SKIP_SUBSKILL_DIRS.has(entry.name);
            const own = includeSkills && childDiscoversSubSkills ? await readSummary(child) : null;
            const below = (includeSkills && childDiscoversSubSkills) || (show && depth < maxDepth)
              ? await walk(child, depth + 1, show && depth < maxDepth, childDiscoversSubSkills)
              : { files: [], sub_skills: [] };
            const node: FileNode = { name: entry.name, type: "directory",
              ...(depth < maxDepth ? { children: below.files } : {}) };
            return { files: show ? [node] : [], sub_skills: [...(own ? [own] : []), ...below.sub_skills] };
          }
          if (entry.isFile() && show) {
            // The async stat preserves actual local file sizes, including edits.
            let size: number | undefined;
            try { size = (await this.fileReads.run(() => stat(join(canonical, entry.name)))).size; } catch {}
            return { files: [{ name: entry.name, type: "file", ...(size === undefined ? {} : { size_bytes: size }) }], sub_skills: [] };
          }
          return { files: [], sub_skills: [] };
        }));
        return { files: results.flatMap((result) => result.files), sub_skills: results.flatMap((result) => result.sub_skills) };
      } catch { return { files: [], sub_skills: [] }; }
    };
    const startParts = relative(root, start).split(sep).filter(Boolean);
    const startDiscoversSubSkills = includeSkills &&
      !startParts.some((name) => SKIP_SUBSKILL_DIRS.has(name));
    const own = startDiscoversSubSkills && start !== root ? await readSummary(start) : null;
    const result = await walk(start, 0, true, startDiscoversSubSkills);
    if (own) result.sub_skills.unshift(own);
    return result;
  }

  /**
   * Scan the file tree of a skill (max depth 2 by default).
   */
  scanStructure(
    dirPath: string,
    entry: ManifestEntry,
    maxDepth: number = 2
  ): SkillStructure {
    const files = this.scanDirectory(dirPath, 0, maxDepth);

    // Find sub-skills: look for nested SKILL.md files
    const subSkills: SubSkillInfo[] = [];
    this.findSubSkills(dirPath, dirPath, subSkills);

    return { files, sub_skills: subSkills };
  }

  private scanDirectory(
    dirPath: string,
    currentDepth: number,
    maxDepth: number
  ): FileNode[] {
    if (!existsSync(dirPath)) return [];

    const nodes: FileNode[] = [];

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (SKIP_NAMES.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          const node: FileNode = {
            name: entry.name,
            type: "directory",
          };
          if (currentDepth < maxDepth) {
            node.children = this.scanDirectory(fullPath, currentDepth + 1, maxDepth);
          }
          nodes.push(node);
        } else if (entry.isFile()) {
          try {
            const stat = statSync(fullPath);
            nodes.push({
              name: entry.name,
              type: "file",
              size_bytes: stat.size,
            });
          } catch {
            nodes.push({ name: entry.name, type: "file" });
          }
        }
      }
    } catch {
      // Permission denied or other errors
    }

    return nodes;
  }

  /**
   * Recursively find sub-skill SKILL.md files (not the root one).
   */
  private findSubSkills(
    rootPath: string,
    currentPath: string,
    results: SubSkillInfo[],
    depth: number = 0
  ): void {
    if (depth > 4) return;

    try {
      const entries = readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_NAMES.has(entry.name) || SKIP_SUBSKILL_DIRS.has(entry.name)) continue;

        const subDir = join(currentPath, entry.name);
        const subSkillMd = resolveWithin(rootPath, join(relative(rootPath, subDir), "SKILL.md"));

        if (existsSync(subSkillMd)) {
          // Extract name from frontmatter or use folder name
          const content = readFileSync(subSkillMd, "utf-8");
          const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+?)$/m);
          const descMatch = content.match(/^---[\s\S]*?description:\s*(.+?)$/m);

          results.push({
            name: nameMatch ? nameMatch[1].trim() : entry.name,
            path: relative(rootPath, subDir),
            description: descMatch ? descMatch[1].trim() : "",
          });
        }

        // Recurse deeper
        this.findSubSkills(rootPath, subDir, results, depth + 1);
      }
    } catch {
      // Permission denied
    }
  }

  /**
   * Detect language and package manager from project files.
   */
  private detectDependencies(skillPath: string): SkillDependencies {
    // Python
    if (existsSync(join(skillPath, "requirements.txt"))) {
      return {
        language: "python",
        package_manager: "pip",
        setup_command: "pip install -r requirements.txt",
      };
    }
    if (existsSync(join(skillPath, "pyproject.toml"))) {
      if (existsSync(join(skillPath, "uv.lock"))) {
        return {
          language: "python",
          package_manager: "uv",
          setup_command: "uv sync",
        };
      }
      return {
        language: "python",
        package_manager: "pip",
        setup_command: "pip install .",
      };
    }

    // Node.js
    if (existsSync(join(skillPath, "package.json"))) {
      return {
        language: "typescript/javascript",
        package_manager: "npm",
        setup_command: "npm install",
      };
    }

    // Go
    if (existsSync(join(skillPath, "go.mod"))) {
      return {
        language: "go",
        package_manager: "go mod",
        setup_command: "go mod download",
      };
    }

    // Pure skill (no runtime dependencies)
    return { language: "markdown-only" };
  }

  /**
   * Load a specific file from within a skill directory.
   */
  async loadSkillFile(
    entry: ManifestEntry,
    filePath: string,
    options: SkillFileReadOptions = {},
  ): Promise<SkillFileReadResult> {
    if (this.config.isRemote) {
      await this.ensureRemoteFetched(entry);
    }

    const skillPath = this.resolveSkillPath(entry);
    const fullPath = resolveWithin(skillPath, filePath);

    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = statSync(fullPath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${filePath}`);
    }

    const ext = extname(fullPath).toLowerCase();
    const declaredMime = BINARY_MIME_TYPES[ext];
    const isBinary = declaredMime !== undefined || looksBinary(fullPath, stat.size);
    if (isBinary) {
      const mime = declaredMime ?? "application/octet-stream";
      return {
        content: `[Binary file: ${filePath} (${stat.size} bytes, ${mime}). Open it from this skill's local_path.]`,
        size_bytes: stat.size,
        offset: 0,
        bytes_returned: 0,
        has_more: false,
        binary: true,
        mime_type: mime,
      };
    }

    return readUtf8FileChunk(
      fullPath,
      stat.size,
      options.offset ?? 0,
      options.maxBytes ?? DEFAULT_FILE_CHUNK_BYTES,
    );
  }

  /** Read a browser-safe raster image for the App's inline preview. */
  async previewImage(entry: ManifestEntry, filePath: string): Promise<SkillImagePreviewResult> {
    if (this.config.isRemote) {
      await this.ensureRemoteFetched(entry);
    }
    const skillPath = this.resolveSkillPath(entry);
    const fullPath = resolveWithin(skillPath, filePath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);
    const info = statSync(fullPath);
    if (!info.isFile()) throw new Error(`Path is not a regular file: ${filePath}`);
    const mime = BINARY_MIME_TYPES[extname(fullPath).toLowerCase()];
    if (!mime || !BROWSER_PREVIEW_IMAGE_MIME_TYPES.has(mime)) {
      throw new Error("This file type cannot be previewed as an image");
    }
    if (info.size > MAX_IMAGE_PREVIEW_BYTES) {
      throw new Error(
        `Image is ${info.size} bytes; inline preview is limited to ${MAX_IMAGE_PREVIEW_BYTES} bytes. ` +
        "Use the copied local path to open the original file."
      );
    }
    const bytes = await readFile(fullPath);
    return {
      mime_type: mime,
      size_bytes: bytes.length,
      data_base64: bytes.toString("base64"),
    };
  }

  /**
   * List files in a subdirectory of a skill.
   */
  async listSkillFiles(
    entry: ManifestEntry,
    subPath: string = "",
    maxDepth: number = 2
  ): Promise<FileNode[]> {
    if (this.config.isRemote) {
      await this.ensureRemoteFetched(entry);
    }

    const skillPath = this.resolveSkillPath(entry);
    const targetPath = resolveWithin(skillPath, subPath);

    if (!existsSync(targetPath)) {
      throw new Error(`Path not found: ${subPath || "."}`);
    }
    if (!statSync(targetPath).isDirectory()) throw new Error(`Path is not a directory: ${subPath}`);

    return this.scanDirectory(targetPath, 0, maxDepth);
  }

  /**
   * Deep cache-state check for one skill. Read-only: never triggers a
   * download. In local mode every skill is on disk by definition.
   */
  cacheState(entry: ManifestEntry): SkillCacheState {
    if (!this.config.isRemote) {
      const localPath = this.resolveSkillPath(entry);
      const instructions = resolveWithin(localPath, "SKILL.md");
      const complete = existsSync(instructions) && statSync(instructions).isFile();
      return {
        cached: existsSync(localPath),
        complete,
        localPath,
        filesTotal: 1,
        filesMissing: complete ? [] : ["SKILL.md"],
        sizeBytes: complete ? statSync(instructions).size : 0,
      };
    }
    return readSkillCacheState(this.config, entry);
  }

  /**
   * Remove one remote skill's materialized cache. Local libraries are source
   * checkouts, not disposable caches, so this method refuses to delete them.
   */
  async clearCache(entry: ManifestEntry): Promise<ClearSkillCacheResult> {
    if (!this.config.isRemote) throw new Error("本地技能目录不是可清除的下载缓存");
    const relativePath = entry.relative_path.replace(/^\.\//, "").replace(/\/+$/, "").trim();
    if (!relativePath || relativePath === ".") {
      throw new Error("技能库根入口不是独立缓存目录，拒绝清除");
    }
    const progress = readSkillDownloadProgress(entry.name);
    if (progress?.active) throw new Error("技能正在下载，完成后再清除缓存");

    const localPath = this.resolveSkillPath(entry);
    const state = this.cacheState(entry);
    if (!state.cached) {
      return {
        found: true,
        cleared: false,
        local_path: localPath,
        files_removed: 0,
        bytes_removed: 0,
      };
    }

    let info;
    try {
      info = await lstat(localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          found: true,
          cleared: false,
          local_path: localPath,
          files_removed: 0,
          bytes_removed: 0,
        };
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("拒绝清除非目录或符号链接形式的技能缓存");
    }

    await rm(localPath, { recursive: true, force: true });
    this.summaries.clear();
    return {
      found: true,
      cleared: true,
      local_path: localPath,
      files_removed: state.filesTotal,
      bytes_removed: state.sizeBytes,
    };
  }

  /**
   * Light cache check (marker + completedAt only) for [cached] badges in
   * search results. In local mode always true.
   */
  isCached(entry: ManifestEntry): boolean {
    if (!this.config.isRemote) return this.cacheState(entry).complete;
    return isSkillCachedLight(this.config, entry);
  }
}
