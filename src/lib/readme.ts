/**
 * Pick the most user-friendly README file from a skill-package root.
 * Chinese variants take precedence over the neutral default and English files.
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

export function preferredReadmeName(names: readonly string[]): string | undefined {
  const sorted = [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  for (const patterns of [CHINESE_README_PATTERNS, ENGLISH_README_PATTERNS]) {
    for (const pattern of patterns) {
      const match = sorted.find((name) => pattern.test(name));
      if (match) return match;
    }
  }
  return undefined;
}
