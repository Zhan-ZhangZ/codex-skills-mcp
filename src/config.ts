import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  skillsDir: string;
  manifestPath: string;
}

/**
 * Parse config from CLI args and env vars.
 * Priority: --skills-dir > CODEX_SKILLS_DIR > auto-detect
 */
export function parseConfig(args: string[]): Config {
  let skillsDir: string | undefined;

  // Parse --skills-dir from CLI args
  const dirIdx = args.indexOf("--skills-dir");
  if (dirIdx !== -1 && args[dirIdx + 1]) {
    skillsDir = resolve(args[dirIdx + 1]);
  }

  // Fallback to env var
  if (!skillsDir && process.env.CODEX_SKILLS_DIR) {
    skillsDir = resolve(process.env.CODEX_SKILLS_DIR);
  }

  // Fallback: check current directory
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

  const manifestPath = resolve(skillsDir, "skills_manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(
      `Error: skills_manifest.json not found in ${skillsDir}`
    );
    process.exit(1);
  }

  return { skillsDir, manifestPath };
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
