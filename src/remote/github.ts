import { writeFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import type { Config, ManifestEntry } from "../config.js";

interface TreeFileEntry {
  /** Path relative to the skill directory, e.g. "README.md" or "skills/nature-reader/SKILL.md" */
  path: string;
  /** File size in bytes (from the git tree API) — used to skip already-downloaded files */
  size: number;
}

interface SkillTreeCache {
  version: 1;
  /** Set only when every file in `files` has been downloaded successfully */
  completedAt?: string;
  files: TreeFileEntry[];
  /** For single-file skills: absolute remote path to fetch (files.path is not prefixed) */
  singleFileRemotePath?: string;
}

/** Metadata marker written inside each cached skill directory */
const TREE_CACHE_FILE = ".codex-skills.tree.json";

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 3000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Fetch with optional auth token
 */
async function fetchWithAuth(url: string, token?: string, timeout = 3000): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetchWithTimeout(url, { headers }, timeout);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res;
}

/**
 * Advanced raw file downloader with Automatic 3-second Timeout Fallback Chain
 */
async function fetchRawWithFallback(config: Config, path: string): Promise<Response> {
  // Define the smart fallback chain
  const fallbacks = [
    // 0. Official direct (Fastest if VPN is on, but fails/timeouts in pure CN network)
    {
      name: "GitHub Official",
      url: `https://raw.githubusercontent.com/${config.githubRepo}/${config.githubBranch}/${path}`,
      useAuth: true,
      timeout: 3000 // 3 seconds timeout for direct connection
    },
    // 1. jsdelivr CDN (Fastest in China without VPN)
    {
      name: "jsDelivr",
      url: `https://cdn.jsdelivr.net/gh/${config.githubRepo}@${config.githubBranch}/${path}`,
      useAuth: false,
      timeout: 10000 // longer timeout for fallbacks
    },
    // 2. gh-proxy.com (Reliable raw proxy)
    {
      name: "gh-proxy.com",
      url: `https://gh-proxy.com/https://raw.githubusercontent.com/${config.githubRepo}/${config.githubBranch}/${path}`,
      useAuth: false,
      timeout: 10000
    },
    // 3. ghfast.top (Backup raw proxy)
    {
      name: "ghfast.top",
      url: `https://ghfast.top/https://raw.githubusercontent.com/${config.githubRepo}/${config.githubBranch}/${path}`,
      useAuth: false,
      timeout: 10000
    }
  ];

  let lastError: any = null;

  for (const proxy of fallbacks) {
    try {
      const res = proxy.useAuth
        ? await fetchWithAuth(proxy.url, config.githubToken, proxy.timeout)
        : await fetchWithTimeout(proxy.url, {}, proxy.timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res; // Success!
    } catch (e: any) {
      console.error(`[codex-skills-mcp] Network warning: [${proxy.name}] failed (${e.message}). Auto-switching to next node...`);
      lastError = e;
    }
  }

  throw new Error(`All download nodes failed to fetch ${path}. Network error: ${lastError?.message}\n\n【网络兜底提示】您的网络环境极其恶劣，所有的直连与免翻墙加速节点均已失效。为了保证技能库的稳定拉取，建议您配置科学上网环境。推荐服务：https://a.xn--30rs3b33gl8gq9hj52b.com/#/register?code=4uq59ogs (该服务极具性价比，最便宜每月200G流量一年仅需13.99元)`);
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
    `${apiBase}contents/${parentRemotePath}?ref=${config.githubBranch}`,
    config.githubToken,
    10000
  );
  const contents = (await contentsRes.json()) as any;

  if (Array.isArray(contents)) {
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
      30000
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
function isFileUpToDate(localPath: string, expectedSize: number): boolean {
  try {
    return statSync(localPath).size === expectedSize;
  } catch {
    return false;
  }
}

/** Verify every recorded file exists with the expected size */
function areFilesUpToDate(tree: SkillTreeCache, skillLocalPath: string): boolean {
  return tree.files.every((file) =>
    isFileUpToDate(resolve(skillLocalPath, file.path), file.size)
  );
}

/**
 * Download every missing file of a skill, skipping files already cached.
 * Failures throw AFTER the pool finishes so the caller can resume next time.
 */
async function downloadMissing(
  config: Config,
  relPath: string,
  tree: SkillTreeCache,
  skillLocalPath: string
): Promise<void> {
  if (!tree.files || tree.files.length === 0) return;

  const skillRemotePath = buildSkillRemotePath(config, relPath);
  const missing = tree.files.filter(
    (file) => !isFileUpToDate(resolve(skillLocalPath, file.path), file.size)
  );
  if (missing.length === 0) return;

  const skillName = basename(skillLocalPath);
  console.error(
    `[codex-skills-mcp] Fetching ${missing.length}/${tree.files.length} files for skill: ${skillName}...`
  );
  const startedAt = Date.now();
  const limit = Math.max(1, config.downloadConcurrency);

  await runPool(missing, limit, async (file) => {
    const remotePath = tree.singleFileRemotePath ?? `${skillRemotePath}/${file.path}`;
    const res = await fetchRawWithFallback(config, remotePath);
    const buffer = Buffer.from(await res.arrayBuffer());
    const localFile = resolve(skillLocalPath, file.path);
    mkdirSync(dirname(localFile), { recursive: true });
    writeFileSync(localFile, buffer);
  });

  console.error(
    `[codex-skills-mcp] Skill ${skillName}: downloaded ${missing.length} files in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
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
 * Download the manifest file, or refresh it if stale (older than config.manifestTTL).
 */
export async function fetchManifest(config: Config): Promise<void> {
  if (existsSync(config.manifestPath)) {
    // Check staleness
    if (config.manifestTTL > 0) {
      try {
        const mtime = statSync(config.manifestPath).mtimeMs;
        const age = Date.now() - mtime;
        if (age < config.manifestTTL) return; // Still fresh
        console.error(`[codex-skills-mcp] Manifest is ${Math.round(age / 3600000)}h old, refreshing...`);
      } catch {
        // Can't stat — fall through to re-download
      }
    } else {
      return; // TTL=0 means never refresh
    }
  }

  const manifestPath = `${config.githubPath}/skills_manifest.json`;
  console.error(`[codex-skills-mcp] Fetching manifest...`);

  const res = await fetchRawWithFallback(config, manifestPath);
  const text = await res.text();

  writeFileSync(config.manifestPath, text, "utf-8");
}

/** Per-skill fetch deduplication: prevents concurrent downloads of the same skill */
const inflightFetches = new Map<string, Promise<void>>();

/**
 * Ensure a skill's directory is downloaded and cached.
 *
 * - Listing uses only 2 API calls (parent contents + recursive subtree tree),
 *   never the full repository tree, so huge repos stay within GitHub limits.
 * - Downloads run concurrently and skip files already cached with the right size.
 * - A `.codex-skills.tree.json` marker records the file list + completion state,
 *   so an interrupted download resumes on the next call instead of being
 *   silently treated as complete.
 * - Concurrent calls for the same skill are deduplicated via a promise lock.
 */
export async function ensureSkillFetched(config: Config, entry: ManifestEntry): Promise<void> {
  const relPath = entry.relative_path.replace(/^\.\//, "");
  const skillLocalPath = resolve(config.skillsDir, relPath);
  const cacheFile = join(skillLocalPath, TREE_CACHE_FILE);

  // Fast path: fully downloaded in a previous run (sync check, no lock needed)
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8")) as SkillTreeCache;
      if (cached.completedAt && Array.isArray(cached.files)) {
        if (areFilesUpToDate(cached, skillLocalPath)) {
          return;
        }
      }
    } catch {
      // Corrupted — fall through to locked fetch
    }
  }

  // Dedup: if another call is already fetching this skill, wait for it
  const existing = inflightFetches.get(relPath);
  if (existing) {
    await existing;
    return;
  }

  const fetchPromise = (async () => {
    try {
      await doFetchSkill(config, entry, relPath, skillLocalPath, cacheFile);
    } finally {
      inflightFetches.delete(relPath);
    }
  })();

  inflightFetches.set(relPath, fetchPromise);
  await fetchPromise;
}

/** Inner fetch logic, called under dedup lock */
async function doFetchSkill(
  config: Config,
  entry: ManifestEntry,
  relPath: string,
  skillLocalPath: string,
  cacheFile: string
): Promise<void> {
  // Re-check after acquiring lock (another caller may have completed)
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8")) as SkillTreeCache;
      if (cached.completedAt && Array.isArray(cached.files)) {
        if (areFilesUpToDate(cached, skillLocalPath)) {
          return;
        }
        // Some files disappeared — fetch only the gaps
        await downloadMissing(config, relPath, cached, skillLocalPath);
        return;
      }
      if (Array.isArray(cached.files)) {
        // Resume: reuse the cached file list
        await downloadMissing(config, relPath, cached, skillLocalPath);
        writeFileSync(
          cacheFile,
          JSON.stringify({ ...cached, completedAt: new Date().toISOString() }, null, 2),
          "utf-8"
        );
        return;
      }
    } catch {
      // Corrupted marker — fall through
    }
  }

  mkdirSync(skillLocalPath, { recursive: true });

  console.error(`[codex-skills-mcp] Listing files for skill: ${entry.name}...`);
  const tree = await fetchSkillTree(config, relPath);
  writeFileSync(cacheFile, JSON.stringify(tree, null, 2), "utf-8");

  await downloadMissing(config, relPath, tree, skillLocalPath);

  writeFileSync(
    cacheFile,
    JSON.stringify({ ...tree, completedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}
