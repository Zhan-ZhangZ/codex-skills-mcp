/**
 * Pick the most user-friendly README file from a skill package.
 * Chinese variants take precedence over the neutral default and English files.
 * When localized documentation lives below the package root, shallower files
 * are preferred so project documentation wins over template/example copies.
 */
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

const ENGLISH_README_PATTERNS: readonly RegExp[] = [
  /^readme\.md$/i,
  /^readme[._-]en\.md$/i,
];

type ReadmeCandidate = {
  path: string;
  language: number;
  variant: number;
  depth: number;
};

export function preferredReadmePath(paths: readonly string[]): string | undefined {
  const candidates: ReadmeCandidate[] = [];
  for (const rawPath of paths) {
    const path = rawPath.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!path) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const [language, patterns] of [CHINESE_README_PATTERNS, ENGLISH_README_PATTERNS].entries()) {
      const variant = patterns.findIndex((pattern) => pattern.test(name));
      if (variant < 0) continue;
      candidates.push({
        path,
        language,
        variant,
        depth: path.split("/").length - 1,
      });
      break;
    }
  }
  candidates.sort((a, b) =>
    a.language - b.language ||
    a.depth - b.depth ||
    a.variant - b.variant ||
    a.path.localeCompare(b.path, "en", { sensitivity: "base" })
  );
  return candidates[0]?.path;
}

export function preferredReadmeName(names: readonly string[]): string | undefined {
  return preferredReadmePath(names);
}
