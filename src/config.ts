import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

export interface Config {
  skillsDir: string;
  manifestPath: string;
  isRemote: boolean;
  githubRepo?: string;
  githubBranch?: string;
  githubPath: string;
  githubToken?: string;
  /**
   * Route downloads through the official CN acceleration endpoint
   * (gh.251716.xyz — a self-hosted read-only reverse proxy of
   * raw.githubusercontent.com). Disable with --no-official-mirror.
   * See README "Official acceleration" for the disclosure.
   */
  useOfficialMirror: boolean;
  /**
   * Hedged download strategy: fire the official endpoint first, and only
   * join the public nodes into the race if it has not succeeded within
   * HEDGE_DELAY_MS (see remote/github.ts). Avoids wasting the official
   * node's narrow uplink pipe on guaranteed-loser race traffic while
   * keeping instant public fallback. Disable with --no-hedge.
   */
  hedgeEnabled: boolean;
  /**
   * Soft overall deadline for read_skill/load_skill_file downloads, in ms.
   * Applies ONLY when the client did not opt into progress notifications
   * (no progressToken): the tool then returns a partial-progress response
   * just before typical client timeouts (~60s) instead of being killed
   * mid-flight. The download keeps running in the background; the next
   * call resumes from the cache. Default 55s. 0 = disabled.
   */
  softDeadlineMs: number;
  /**
   * Hard absolute deadline for any single download call, in ms, regardless
   * of progress opt-in. Guards against pathological networks hanging a
   * call forever. Default 285s — deliberately UNDER common client request
   * timeouts (e.g. Codex uses 300s) so our structured partial-progress
   * response always arrives BEFORE the client would kill the call.
   * 0 = disabled.
   */
  hardDeadlineMs: number;
  downloadConcurrency: number;
  /** Manifest cache TTL in milliseconds. Default 24 hours. 0 = never refresh. */
  manifestTTL: number;
  /**
   * Throttled manifest freshness poll interval in milliseconds (conditional
   * GET on search/plan calls). Default 5 minutes. 0 = disabled.
   * See docs/IMPROVEMENT-MANIFEST-FRESHNESS.md.
   */
  manifestPollMs: number;
  /** Base download timeout for skill files in milliseconds. Default: 30000 (30s). */
  downloadTimeout: number;
  /**
   * Option keys explicitly provided via CLI flags this run. Persisted user
   * settings (~/.codex-skills-mcp/settings.json) must NOT override these —
   * precedence is CLI > persisted settings > defaults.
   */
  explicitCli?: Set<string>;
}

/**
 * Helper to extract GitHub token from Git credentials
 */
function getGitGithubToken(): string | undefined {
  try {
    const output = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
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
    if (idx === -1) return undefined;
    const value = args[idx + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  const integerOption = (flag: string, fallback: string, min: number, max: number) => {
    const raw = getArg(flag) ?? fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${flag} must be an integer between ${min} and ${max}`);
    }
    return value;
  };
  
  const explicitCli = new Set<string>();
  const markExplicit = (flag: string, key: string) => {
    if (args.includes(flag)) explicitCli.add(key);
  };
  markExplicit("--no-official-mirror", "official_mirror");
  markExplicit("--no-hedge", "hedge");
  markExplicit("--soft-deadline-seconds", "soft_deadline_seconds");
  markExplicit("--hard-deadline-seconds", "hard_deadline_seconds");
  markExplicit("--download-concurrency", "download_concurrency");
  markExplicit("--download-timeout", "download_timeout_seconds");
  markExplicit("--manifest-ttl", "manifest_ttl_hours");
  markExplicit("--manifest-poll", "manifest_poll_seconds");

  const githubRepo = getArg("--github-repo") || "Zhan-ZhangZ/codexprojec";
  const githubBranch = getArg("--github-branch") || "main";
  const githubPath = getArg("--github-path") || "codex-skills";
  
  let githubToken = getArg("--github-token");
  
  // Fallback to valid ENV token
  if (!githubToken && process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== "github_pat_antigravitydummytoken") {
    githubToken = process.env.GITHUB_TOKEN;
  }
  
  const isLocal = args.includes("--local") || args.includes("--skills-dir") || !!process.env.CODEX_SKILLS_DIR;
  // Local mode never needs a credential helper or interactive prompt.
  if (!githubToken && !isLocal) {
    githubToken = getGitGithubToken();
  }

  // It defaults to remote mode unless explicitly run locally
  let isRemote = true;
  if (isLocal) {
    isRemote = false;
  }

  if (isRemote) {
    const cacheDirArg = getArg("--cache-dir");
    const cacheDirEnv = process.env.CODEX_SKILLS_CACHE_DIR;
    skillsDir = cacheDirArg
      ? resolve(cacheDirArg)
      : cacheDirEnv
      ? resolve(cacheDirEnv)
      : resolve(homedir(), ".codex-skills-cache");
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }
  } else {
    // Local mode logic
    const dirIdx = args.indexOf("--skills-dir");
    if (dirIdx !== -1 && args[dirIdx + 1]) {
      skillsDir = resolve(getArg("--skills-dir")!);
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

  const useOfficialMirror = !args.includes("--no-official-mirror");
  const hedgeEnabled = !args.includes("--no-hedge");

  // Soft/hard overall call deadlines (seconds; 0 disables). Soft applies
  // only to clients without a progressToken — see read-skill.ts.
  const softDeadlineMs = integerOption("--soft-deadline-seconds", "55", 0, 86400) * 1000;
  // 285s default: just under common 300s client timeouts (e.g. Codex) so
  // our partial response wins the race against the client giving up.
  const hardDeadlineMs = integerOption("--hard-deadline-seconds", "285", 0, 86400) * 1000;

  // Manifest cache TTL (default: 24 hours). --manifest-ttl <seconds> or 0 to disable.
  const manifestTTL = integerOption("--manifest-ttl", "86400", 0, 604800) * 1000;

  // Freshness poll interval (default: 5 minutes). --manifest-poll <seconds>
  // or CODEX_SKILLS_MANIFEST_POLL_SECONDS; 0 disables the poll.
  const pollEnv = process.env.CODEX_SKILLS_MANIFEST_POLL_SECONDS;
  const manifestPollSeconds = integerOption("--manifest-poll", pollEnv ?? "300", 0, 3600);
  const manifestPollMs = manifestPollSeconds * 1000;

  // Concurrent downloads for skill files (default 16). Configurable via
  // --download-concurrency <n> or CODEX_SKILLS_DOWNLOAD_CONCURRENCY env var.
  const concurrencyEnv = process.env.CODEX_SKILLS_DOWNLOAD_CONCURRENCY;
  const downloadConcurrency = integerOption("--download-concurrency", concurrencyEnv ?? "16", 1, 64);

  // Base download timeout for skill files (default 30 seconds). Configurable via
  // --download-timeout <seconds> or CODEX_SKILLS_DOWNLOAD_TIMEOUT env var.
  const timeoutEnv = process.env.CODEX_SKILLS_DOWNLOAD_TIMEOUT;
  const downloadTimeoutSeconds = integerOption("--download-timeout", timeoutEnv ?? "30", 1, 300);
  const downloadTimeout = downloadTimeoutSeconds * 1000;

  return { 
    explicitCli,
    skillsDir, 
    manifestPath, 
    isRemote, 
    githubRepo, 
    githubBranch, 
    githubPath, 
    githubToken,
    useOfficialMirror,
    hedgeEnabled,
    softDeadlineMs,
    hardDeadlineMs,
    downloadConcurrency,
    manifestTTL,
    manifestPollMs,
    downloadTimeout
  };
}

export interface ManifestEntry {
  name: string;
  description: string;
  category: string;
  folder: string;
  relative_path: string;
  // Metadata Extensions
  aliases?: string[];
  tags?: string[];
  language?: string;
  dependencies?: string[];
  updated_at?: string;
  stars?: number;
}

export function loadManifest(manifestPath: string): ManifestEntry[] {
  const raw = readFileSync(manifestPath, "utf-8");
  return parseManifest(JSON.parse(raw));
}

/** Validate remote/local data at the boundary, before indexing or writing it. */
export function parseManifest(value: unknown): ManifestEntry[] {
  if (!Array.isArray(value)) throw new Error("Manifest must be an array");
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid manifest entry ${index}`);
    }
    for (const field of ["name", "description", "category", "folder", "relative_path"]) {
      if (typeof entry[field] !== "string") throw new Error(`Manifest entry ${index}: ${field} must be a string`);
    }
    const path = entry.relative_path as string;
    if (!entry.name.trim() || !path || /^[\/\\]|^[a-z]:/i.test(path) || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
      throw new Error(`Manifest entry ${index}: invalid name or relative_path`);
    }
    const name = entry.name.toLowerCase();
    if (names.has(name)) throw new Error(`Manifest contains duplicate name: ${entry.name}`);
    names.add(name);
    for (const field of ["aliases", "tags", "dependencies"]) {
      if (entry[field] !== undefined && (!Array.isArray(entry[field]) || !entry[field].every((v: unknown) => typeof v === "string"))) {
        throw new Error(`Manifest entry ${index}: ${field} must be a string array`);
      }
    }
  }
  return value as ManifestEntry[];
}
