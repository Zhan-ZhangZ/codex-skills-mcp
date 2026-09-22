import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative, extname } from "node:path";
import type { ManifestEntry, Config } from "../config.js";
import type { ProgressCallback } from "../remote/github.js";
import { readSkillCacheState, isSkillCachedLight, type SkillCacheState } from "../remote/github.js";

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
}

// Files/dirs to skip when scanning structure
const SKIP_NAMES = new Set([
  "node_modules", ".git", ".github", "__pycache__",
  ".DS_Store", ".env", ".venv", "venv",
  "dist", "build", ".next", ".cache",
]);

// Max file size to return via load_skill_file (500KB)
const MAX_FILE_SIZE = 500 * 1024;

/**
 * Skill loader — reads SKILL.md, scans structure, detects dependencies.
 */
export class SkillLoader {
  private skillsDir: string;
  private _ensureSkillFetched:
    | ((config: Config, entry: ManifestEntry, onProgress?: ProgressCallback) => Promise<void>)
    | null = null;

  constructor(
    private config: Config,
    private manifest: ManifestEntry[]
  ) {
    this.skillsDir = config.skillsDir;
  }

  /** Lazy-load remote module only when needed */
  private async ensureRemoteFetched(
    entry: ManifestEntry,
    onProgress?: ProgressCallback
  ): Promise<void> {
    if (!this._ensureSkillFetched) {
      const { ensureSkillFetched } = await import("../remote/github.js");
      this._ensureSkillFetched = ensureSkillFetched;
    }
    await this._ensureSkillFetched(this.config, entry, onProgress);
  }

  /**
   * Resolve the absolute filesystem path for a skill.
   */
  resolveSkillPath(entry: ManifestEntry): string {
    // relative_path starts with "./" and is relative to the manifest dir
    const relPath = entry.relative_path.replace(/^\.\//, "");
    return resolve(this.skillsDir, relPath);
  }

  /**
   * Read a skill's SKILL.md + structure + dependencies.
   */
  async readSkill(entry: ManifestEntry, onProgress?: ProgressCallback): Promise<ReadSkillResult> {
    if (this.config.isRemote) {
      await this.ensureRemoteFetched(entry, onProgress);
    }

    const skillPath = this.resolveSkillPath(entry);

    // Read SKILL.md
    let instructions = "";
    const skillMdPath = join(skillPath, "SKILL.md");
    if (existsSync(skillMdPath)) {
      instructions = readFileSync(skillMdPath, "utf-8");
    } else {
      instructions = `[No SKILL.md found for ${entry.name}]\n\nDescription: ${entry.description}`;
    }

    // Scan structure
    const structure = this.scanStructure(skillPath, entry);

    // Detect dependencies
    const dependencies = this.detectDependencies(skillPath);

    return { instructions, structure, dependencies };
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
        if (SKIP_NAMES.has(entry.name)) continue;

        const subDir = join(currentPath, entry.name);
        const subSkillMd = join(subDir, "SKILL.md");

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
    filePath: string
  ): Promise<{ content: string; size_bytes: number }> {
    if (this.config.isRemote) {
      await this.ensureRemoteFetched(entry);
    }

    const skillPath = this.resolveSkillPath(entry);
    const fullPath = resolve(skillPath, filePath);

    // Security: ensure the resolved path is within the skill directory
    if (!fullPath.startsWith(skillPath)) {
      throw new Error("Path traversal detected: file must be within skill directory");
    }

    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }

    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${Math.round(stat.size / 1024)}KB). Max: ${MAX_FILE_SIZE / 1024}KB`
      );
    }

    // Check if binary
    const ext = extname(fullPath).toLowerCase();
    const binaryExts = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
      ".woff", ".woff2", ".ttf", ".eot",
      ".zip", ".7z", ".tar", ".gz",
      ".exe", ".dll", ".so", ".dylib",
      ".pdf", ".doc", ".docx",
    ]);

    if (binaryExts.has(ext)) {
      return {
        content: `[Binary file: ${filePath} (${stat.size} bytes)]`,
        size_bytes: stat.size,
      };
    }

    const content = readFileSync(fullPath, "utf-8");
    return { content, size_bytes: stat.size };
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
    const targetPath = subPath ? resolve(skillPath, subPath) : skillPath;

    // Security check
    if (!targetPath.startsWith(skillPath)) {
      throw new Error("Path traversal detected");
    }

    if (!existsSync(targetPath)) {
      throw new Error(`Path not found: ${subPath || "."}`);
    }

    return this.scanDirectory(targetPath, 0, maxDepth);
  }

  /**
   * Deep cache-state check for one skill. Read-only: never triggers a
   * download. In local mode every skill is on disk by definition.
   */
  cacheState(entry: ManifestEntry): SkillCacheState {
    if (!this.config.isRemote) {
      return {
        cached: true,
        complete: true,
        localPath: this.resolveSkillPath(entry),
        filesTotal: 0,
        filesMissing: [],
        sizeBytes: 0,
      };
    }
    return readSkillCacheState(this.config, entry);
  }

  /**
   * Light cache check (marker + completedAt only) for [cached] badges in
   * search results. In local mode always true.
   */
  isCached(entry: ManifestEntry): boolean {
    if (!this.config.isRemote) return true;
    return isSkillCachedLight(this.config, entry);
  }
}
