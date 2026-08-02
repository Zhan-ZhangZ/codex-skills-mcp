import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

export interface Config {
  skillsDir: string;
  manifestPath: string;
  isRemote: boolean;
  githubRepo?: string;
  githubBranch?: string;
  githubPath?: string;
  githubToken?: string;
}

/**
 * Helper to extract GitHub token from Git credentials
 */
function getGitGithubToken(): string | undefined {
  try {
    const output = execSync('echo "protocol=https\\nhost=github.com\\n" | git credential fill', {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"]
    });
    const match = output.match(/^password=(.+)$/m);
    if (match && match[1]) {
      // Don't log the full token
      console.error("[codex-skills-mcp] Auto-detected GitHub token from Git credentials");
      return match[1].trim();
    }
  } catch (err) {
    // Ignore errors (git not installed or no credentials)
  }
  return undefined;
}

/**
 * Parse config from CLI args and env vars.
 */
export function parseConfig(args: string[]): Config {
  let skillsDir: string | undefined;
  
  // Parse github arguments
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };
  
  const githubRepo = getArg("--github-repo") || "Zhan-ZhangZ/codexprojec";
  const githubBranch = getArg("--github-branch") || "main-lite";
  const githubPath = getArg("--github-path") || "codex-skills";
  
  let githubToken = getArg("--github-token");
  
  // Fallback to valid ENV token
  if (!githubToken && process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== "github_pat_antigravitydummytoken") {
    githubToken = process.env.GITHUB_TOKEN;
  }
  
  // Fallback to Git credentials
  if (!githubToken) {
    githubToken = getGitGithubToken();
  }

  // It defaults to remote mode unless explicitly run locally
  let isRemote = true;
  if (args.includes("--local") || args.indexOf("--skills-dir") !== -1 || process.env.CODEX_SKILLS_DIR) {
    isRemote = false;
  }

  if (isRemote) {
    skillsDir = resolve(process.cwd(), ".codex-skills-cache");
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }
  } else {
    // Local mode logic
    const dirIdx = args.indexOf("--skills-dir");
    if (dirIdx !== -1 && args[dirIdx + 1]) {
      skillsDir = resolve(args[dirIdx + 1]);
    }

    if (!skillsDir && process.env.CODEX_SKILLS_DIR) {
      skillsDir = resolve(process.env.CODEX_SKILLS_DIR);
    }

    if (!skillsDir) {
      const cwd = process.cwd();
      if (existsSync(resolve(cwd, "skills_manifest.json"))) {
        skillsDir = cwd;
      }
    }

    if (!skillsDir) {
      console.error(
        "Error: Skills directory not found.\n" +
          "Specify via --skills-dir <path> or CODEX_SKILLS_DIR env var.\n" +
          "The directory must contain skills_manifest.json."
      );
      process.exit(1);
    }
  }

  const manifestPath = resolve(skillsDir, "skills_manifest.json");
  if (!isRemote && !existsSync(manifestPath)) {
    console.error(
      `Error: skills_manifest.json not found in ${skillsDir}`
    );
    process.exit(1);
  }

  return { 
    skillsDir, 
    manifestPath, 
    isRemote, 
    githubRepo, 
    githubBranch, 
    githubPath, 
    githubToken 
  };
}

export interface ManifestEntry {
  name: string;
  description: string;
  category: string;
  folder: string;
  relative_path: string;
}

export function loadManifest(manifestPath: string): ManifestEntry[] {
  const raw = readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as ManifestEntry[];
}
