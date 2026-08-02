import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Config, ManifestEntry } from "../config.js";

interface GithubContentsItem {
  name: string;
  path: string;
  sha: string;
  size?: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: "file" | "dir";
}

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
 * Initialize remote caching (just creates the cache dir now)
 */
export async function initRemote(config: Config): Promise<void> {
  if (!existsSync(config.skillsDir)) {
    mkdirSync(config.skillsDir, { recursive: true });
  }
}

/**
 * Download the manifest file
 */
export async function fetchManifest(config: Config): Promise<void> {
  if (existsSync(config.manifestPath)) return;

  const manifestPath = `${config.githubPath}/skills_manifest.json`;
  console.error(`[codex-skills-mcp] Fetching manifest...`);

  const res = await fetchRawWithFallback(config, manifestPath);
  const text = await res.text();

  writeFileSync(config.manifestPath, text, "utf-8");
}

/**
 * Recursively fetch files from a GitHub directory using Contents API
 */
async function fetchDirectoryRecursive(
  config: Config,
  path: string
): Promise<{ path: string; downloadUrl: string }[]> {
  try {
    const url = `https://api.github.com/repos/${config.githubRepo}/contents/${path}?ref=${config.githubBranch}`;
    const res = await fetchWithAuth(url, config.githubToken, 10000);
    const data = (await res.json()) as GithubContentsItem[];

    let files: { path: string; downloadUrl: string }[] = [];

    for (const item of data) {
      if (item.type === "file" && item.download_url) {
        files.push({ path: item.path, downloadUrl: item.download_url });
      } else if (item.type === "dir") {
        const subFiles = await fetchDirectoryRecursive(config, item.path);
        files.push(...subFiles);
      }
    }

    return files;
  } catch (error: any) {
    throw new Error(`Failed to fetch directory from GitHub API: ${error.message}\n\n【网络兜底提示】由于网络封锁，无法连接到 GitHub API。建议您配置科学上网环境：https://a.xn--30rs3b33gl8gq9hj52b.com/#/register?code=4uq59ogs (极具性价比，最便宜每月200G流量一年仅需13.99元)`);
  }
}

/**
 * Ensure a skill's directory is downloaded and cached
 */
export async function ensureSkillFetched(config: Config, entry: ManifestEntry): Promise<void> {
  const relPath = entry.relative_path.replace(/^\.\//, "");
  const skillLocalPath = resolve(config.skillsDir, relPath);
  
  if (existsSync(skillLocalPath)) {
    return; // Already fetched
  }

  let prefix = config.githubPath ? `${config.githubPath}/${relPath}` : relPath;
  if (prefix.startsWith("/")) prefix = prefix.slice(1);
  if (prefix.startsWith("./")) prefix = prefix.slice(2);

  try {
    const filesToFetch = await fetchDirectoryRecursive(config, prefix);

    if (filesToFetch.length === 0) {
      console.error(`[codex-skills-mcp] Warning: No files found in remote tree for prefix ${prefix}`);
      mkdirSync(skillLocalPath, { recursive: true });
      return;
    }

    console.error(`[codex-skills-mcp] Fetching ${filesToFetch.length} files for skill: ${entry.name}...`);

    for (const file of filesToFetch) {
      let relativeFilePath = file.path;
      if (config.githubPath && relativeFilePath.startsWith(config.githubPath + "/")) {
        relativeFilePath = relativeFilePath.substring(config.githubPath.length + 1);
      }
      
      const localFilePath = resolve(config.skillsDir, relativeFilePath);
      mkdirSync(dirname(localFilePath), { recursive: true });
      
      // Use smart fallback logic for raw files
      const res = await fetchRawWithFallback(config, file.path);
      const buffer = await res.arrayBuffer();
      writeFileSync(localFilePath, Buffer.from(buffer));
    }
  } catch (error: any) {
    console.error(`[codex-skills-mcp] Failed to fetch skill ${entry.name}: ${error.message}`);
    mkdirSync(skillLocalPath, { recursive: true });
  }
}
