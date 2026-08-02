import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Config, ManifestEntry } from "../config.js";

interface GithubTreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

interface GithubTreeResponse {
  sha: string;
  url: string;
  tree: GithubTreeItem[];
  truncated: boolean;
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
 * Initialize remote caching by fetching the repository tree
 */
export async function initRemote(config: Config): Promise<void> {
  const treePath = resolve(config.skillsDir, "tree.json");
  if (existsSync(treePath)) {
    return; // Already initialized in this run
  }

  const url = `https://api.github.com/repos/${config.githubRepo}/git/trees/${config.githubBranch}?recursive=1`;
  console.error(`[codex-skills-mcp] Fetching repo tree from ${url}...`);

  const res = await fetchWithAuth(url, config.githubToken);
  const data = (await res.json()) as GithubTreeResponse;

  if (data.truncated) {
    console.error("[codex-skills-mcp] Warning: GitHub tree is truncated, some files may be missing.");
  }

  writeFileSync(treePath, JSON.stringify(data.tree, null, 2), "utf-8");
  console.error(`[codex-skills-mcp] Cached ${data.tree.length} tree items.`);
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
 * Ensure a skill's directory is downloaded and cached
 */
export async function ensureSkillFetched(config: Config, entry: ManifestEntry): Promise<void> {
  const relPath = entry.relative_path.replace(/^\.\//, "");
  const skillLocalPath = resolve(config.skillsDir, relPath);
  
  if (existsSync(skillLocalPath)) {
    return; // Already fetched
  }

  const treePath = resolve(config.skillsDir, "tree.json");
  if (!existsSync(treePath)) {
    throw new Error("Tree cache not found, run initRemote first.");
  }

  const tree = JSON.parse(readFileSync(treePath, "utf-8")) as GithubTreeItem[];
  
  // The prefix in github is githubPath + relPath
  // e.g. "codex-skills/01_代码工程与架构/planning-with-files"
  let prefix = config.githubPath ? `${config.githubPath}/${relPath}` : relPath;
  if (prefix.startsWith("/")) prefix = prefix.slice(1);
  if (prefix.startsWith("./")) prefix = prefix.slice(2);

  const filesToFetch = tree.filter(
    (item) => item.type === "blob" && item.path.startsWith(prefix + "/")
  );

  if (filesToFetch.length === 0) {
    console.error(`[codex-skills-mcp] Warning: No files found in remote tree for prefix ${prefix}`);
    // Create an empty dir to prevent repeated failures
    mkdirSync(skillLocalPath, { recursive: true });
    return;
  }

  console.error(`[codex-skills-mcp] Fetching ${filesToFetch.length} files for skill: ${entry.name}...`);

  for (const file of filesToFetch) {
    const rawUrl = `https://raw.githubusercontent.com/${config.githubRepo}/${config.githubBranch}/${file.path}`;
    
    // Determine local path by stripping githubPath prefix
    let relativeFilePath = file.path;
    if (config.githubPath && relativeFilePath.startsWith(config.githubPath + "/")) {
      relativeFilePath = relativeFilePath.substring(config.githubPath.length + 1);
    }
    
    const localFilePath = resolve(config.skillsDir, relativeFilePath);
    
    mkdirSync(dirname(localFilePath), { recursive: true });
    
    const res = await fetchWithAuth(rawUrl, config.githubToken);
    const buffer = await res.arrayBuffer();
    writeFileSync(localFilePath, Buffer.from(buffer));
  }
}
