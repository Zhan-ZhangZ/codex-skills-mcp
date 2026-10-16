import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Segment-aware containment, including existing symlink ancestors. */
export function resolveWithin(root: string, requested: string): string {
  if (requested.includes("\0") || requested.includes("\\")) {
    throw new Error("Invalid path");
  }
  const base = resolve(root);
  const target = resolve(base, requested);
  const contained = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!contained(base, target)) throw new Error("Path traversal detected: path must stay within its directory");
  if (existsSync(base)) {
    let ancestor = target;
    while (!existsSync(ancestor) && ancestor !== base) ancestor = dirname(ancestor);
    if (!contained(realpathSync(base), realpathSync(ancestor))) {
      throw new Error("Path traversal detected: symlink leaves its directory");
    }
  }
  return target;
}
