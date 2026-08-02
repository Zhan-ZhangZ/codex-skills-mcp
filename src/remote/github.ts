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
 * Fetch with optional auth token
 */
async function fetchWithAuth(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res;
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

  const rawUrl = `https://raw.githubusercontent.com/${config.githubRepo}/${config.githubBranch}/${config.githubPath}/skills_manifest.json`;
  console.error(`[codex-skills-mcp] Fetching manifest from ${rawUrl}...`);

  const res = await fetchWithAuth(rawUrl, config.githubToken);
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
  const url = `https://api.github.com/repos/${config.githubRepo}/contents/${path}?ref=${config.githubBranch}`;
  const res = await fetchWithAuth(url, config.githubToken);
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

  // The prefix in github is githubPath + relPath
  // e.g. "codex-skills/01_代码工程与架构/planning-with-files"
  let prefix = config.githubPath ? `${config.githubPath}/${relPath}` : relPath;
  if (prefix.startsWith("/")) prefix = prefix.slice(1);
  if (prefix.startsWith("./")) prefix = prefix.slice(2);

  try {
    const filesToFetch = await fetchDirectoryRecursive(config, prefix);

    if (filesToFetch.length === 0) {
      console.error(`[codex-skills-mcp] Warning: No files found in remote tree for prefix ${prefix}`);
      // Create an empty dir to prevent repeated failures
      mkdirSync(skillLocalPath, { recursive: true });
      return;
    }

    console.error(`[codex-skills-mcp] Fetching ${filesToFetch.length} files for skill: ${entry.name}...`);

    for (const file of filesToFetch) {
      // Determine local path by stripping githubPath prefix
      let relativeFilePath = file.path;
      if (config.githubPath && relativeFilePath.startsWith(config.githubPath + "/")) {
        relativeFilePath = relativeFilePath.substring(config.githubPath.length + 1);
      }
      
      const localFilePath = resolve(config.skillsDir, relativeFilePath);
      
      mkdirSync(dirname(localFilePath), { recursive: true });
      
      const res = await fetchWithAuth(file.downloadUrl, config.githubToken);
      const buffer = await res.arrayBuffer();
      writeFileSync(localFilePath, Buffer.from(buffer));
    }
  } catch (error: any) {
    console.error(`[codex-skills-mcp] Failed to fetch skill ${entry.name}: ${error.message}`);
    // Create an empty dir to prevent repeated failures on 404
    mkdirSync(skillLocalPath, { recursive: true });
  }
}
