/**
 * Pick the most user-friendly README file from a skill package.
 * The requested language wins over the neutral default, while the neutral
 * README remains a fallback for packages that only ship one documentation file.
 * When localized documentation lives below the package root, shallower files
 * are preferred so project documentation wins over template/example copies.
 */
export type ReadmeLanguage = "zh-CN" | "en";

const CHINESE_README_PATTERNS: readonly RegExp[] = [
  /^readme[._-]zh-cn\.md$/i,
  /^readme[._-]zh-hans\.md$/i,
  /^readme[._-]zh\.md$/i,
  /^readme[._-]zh-tw\.md$/i,
  /^readme[._-]zh-hant\.md$/i,
  /^readme[._-]cn\.md$/i,
  /^readme[._-]chinese\.md$/i,
  /^readme[._-]中文\.md$/i,
  /^readme中文\.md$/i,
];

const EXPLICIT_ENGLISH_README_PATTERNS: readonly RegExp[] = [
  /^readme[._-]en(?:[._-](?:us|gb))?\.md$/i,
  /^readme[._-]english\.md$/i,
  /^readme[._-]英文\.md$/i,
];

const NEUTRAL_README_PATTERN: readonly RegExp[] = [/^readme\.md$/i];

type ReadmeCandidate = {
  path: string;
  priority: number;
  variant: number;
  depth: number;
};

export function normalizeReadmeLanguage(value: unknown): ReadmeLanguage {
  return typeof value === "string" && /^en(?:[-_]|$)/i.test(value.trim())
    ? "en"
    : "zh-CN";
}

export function preferredReadmePath(
  paths: readonly string[],
  preferredLanguage: ReadmeLanguage = "zh-CN",
): string | undefined {
  const candidates: ReadmeCandidate[] = [];
  const groups = preferredLanguage === "en"
    ? [
        { patterns: EXPLICIT_ENGLISH_README_PATTERNS, priority: 0 },
        { patterns: NEUTRAL_README_PATTERN, priority: 1 },
        { patterns: CHINESE_README_PATTERNS, priority: 2 },
      ]
    : [
        { patterns: CHINESE_README_PATTERNS, priority: 0 },
        { patterns: NEUTRAL_README_PATTERN, priority: 1 },
        { patterns: EXPLICIT_ENGLISH_README_PATTERNS, priority: 2 },
      ];
  for (const rawPath of paths) {
    const path = rawPath.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!path) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const { patterns, priority } of groups) {
      const variant = patterns.findIndex((pattern) => pattern.test(name));
      if (variant < 0) continue;
      candidates.push({
        path,
        priority,
        variant,
        depth: path.split("/").length - 1,
      });
      break;
    }
  }
  candidates.sort((a, b) =>
    a.priority - b.priority ||
    a.depth - b.depth ||
    a.variant - b.variant ||
    a.path.localeCompare(b.path, "en", { sensitivity: "base" })
  );
  return candidates[0]?.path;
}

export function preferredReadmeName(
  names: readonly string[],
  preferredLanguage: ReadmeLanguage = "zh-CN",
): string | undefined {
  return preferredReadmePath(names, preferredLanguage);
}
