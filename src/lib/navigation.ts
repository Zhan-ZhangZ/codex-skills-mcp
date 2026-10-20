import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import type { FileNode, SubSkillInfo } from "../loader/index.js";

export type NavigationView = "files" | "sub_skills";
export const DEFAULT_NAVIGATION_LIMIT = 50;
export const MAX_NAVIGATION_LIMIT = 100;
export const NAVIGATION_BYTES = 12 * 1024;

export interface NavigationRow {
  name: string;
  path: string;
  type: "file" | "directory" | "sub_skill";
  description?: string;
  size_bytes?: number;
  depth?: number;
}

export interface NavigationContext {
  identity: string;
  skillName: string;
  view: NavigationView;
  path?: string;
  query?: string;
  maxDepth?: number;
}

export interface NavigationPage {
  rows: { row: NavigationRow; text: string; excerpted: boolean }[];
  total: number;
  matched: number;
  offset: number;
  returned: number;
  nextCursor?: string;
  bytes: number;
  excerpted: boolean;
}

// Tokens live for this process only, without retaining potentially huge page
// snapshots. A restart or any source/content/filter change requires page one.
const cursorKey = randomBytes(32);
const CURSOR_ERROR = "Invalid or expired navigation cursor. The source, content, or query may have changed. Repeat list_skill_files without cursor to restart from the first page.";

export function navigationPath(value = ""): string {
  if (value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) throw new Error("Navigation path must be relative to the skill");
  const normalized = posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) throw new Error("Navigation path must stay within the skill");
  return normalized === "." ? "" : normalized.replace(/\/$/, "");
}

const normalizedQuery = (value = ""): string => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

export function fileNavigationRows(nodes: FileNode[], basePath = ""): NavigationRow[] {
  const rows: NavigationRow[] = [];
  const walk = (items: FileNode[], parent: string, depth: number) => {
    for (const node of items) {
      const path = parent ? parent + "/" + node.name : node.name;
      rows.push({ name: node.name, path, type: node.type, size_bytes: node.size_bytes, depth });
      if (node.children) walk(node.children, path, depth + 1);
    }
  };
  walk(nodes, navigationPath(basePath), 0);
  return rows;
}

export function subSkillNavigationRows(items: SubSkillInfo[]): NavigationRow[] {
  return items.map(item => ({ ...item, type: "sub_skill" }));
}

/** Excerpts apply only to navigation labels, never to skill instructions. */
function excerpt(value: string, budget: number): { text: string; excerpted: boolean } {
  const singleLine = value.replace(/[\r\n\t]+/g, " ");
  if (Buffer.byteLength(singleLine) <= budget) return { text: singleLine, excerpted: false };
  let text = "";
  let bytes = 0;
  for (const char of singleLine) {
    const length = Buffer.byteLength(char);
    if (bytes + length > budget - 3) break;
    text += char;
    bytes += length;
  }
  return { text: text + "…", excerpted: true };
}

function render(row: NavigationRow): { text: string; excerpted: boolean } {
  if (row.type === "sub_skill") {
    const name = excerpt(row.name, 200);
    const description = excerpt(row.description ?? "", 600);
    return { text: `- **${name.text}** (${row.path}): ${description.text}`, excerpted: name.excerpted || description.excerpted };
  }
  const icon = row.type === "directory" ? "📁" : "📄";
  const suffix = row.type === "directory" ? "/" : row.size_bytes
    ? ` (${row.size_bytes > 1024 ? Math.round(row.size_bytes / 1024) + "KB" : row.size_bytes + "B"})` : "";
  // Every paged row carries the complete relative path, including pages that
  // start in the middle of a directory. No ancestor context is lost.
  return { text: `${icon} ${row.path}${suffix}`, excerpted: false };
}

function sign(payload: string): Buffer {
  return createHmac("sha256", cursorKey).update(payload).digest();
}

function encodeCursor(offset: number, revision: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, i: offset, r: revision })).toString("base64url");
  return payload + "." + sign(payload).toString("base64url");
}

function decodeCursor(cursor: string, revision: string): number {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const [payload, encodedSignature] = cursor.split(".");
    const signature = Buffer.from(encodedSignature, "base64url");
    if (signature.length !== 32 || !timingSafeEqual(signature, sign(payload))) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.v !== 1 || decoded.r !== revision || !Number.isSafeInteger(decoded.i) || decoded.i < 0) throw new Error();
    return decoded.i;
  } catch { throw new Error(CURSOR_ERROR); }
}

export function navigationPage(
  rows: NavigationRow[], context: NavigationContext,
  options: { limit?: number; cursor?: string } = {},
): NavigationPage {
  const limit = options.limit ?? DEFAULT_NAVIGATION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_NAVIGATION_LIMIT) throw new Error("Navigation limit must be an integer from 1 to 100");
  const query = normalizedQuery(context.query);
  const hash = createHash("sha256").update(JSON.stringify([
    "navigation-v1", context.identity, context.skillName, context.view, navigationPath(context.path),
    query, context.view === "files" ? context.maxDepth ?? 2 : null,
  ]));
  // Bind every row, including matches beyond the first page and metadata used
  // for filtering. Local edits and cached-revision changes cannot reuse offsets.
  for (const row of rows) hash.update(JSON.stringify(row)).update("\n");
  const revision = hash.digest("hex");
  const terms = query ? query.split(" ") : [];
  const filtered = terms.length ? rows.filter(row => {
    const haystack = normalizedQuery([row.name, row.path, row.description ?? ""].join(" "));
    return terms.every(term => haystack.includes(term));
  }) : rows;
  const offset = options.cursor ? decodeCursor(options.cursor, revision) : 0;
  if (offset > filtered.length) throw new Error(CURSOR_ERROR);
  const result: NavigationPage = { rows: [], total: rows.length, matched: filtered.length, offset, returned: 0, bytes: 0, excerpted: false };
  for (let index = offset; index < filtered.length && result.rows.length < limit; index++) {
    const row = filtered[index];
    const rendered = render(row);
    const bytes = Buffer.byteLength(rendered.text) + 1;
    if (bytes > NAVIGATION_BYTES) throw new Error("A navigation path exceeds the page byte budget. Narrow the directory path before listing it.");
    if (result.bytes + bytes > NAVIGATION_BYTES) break;
    result.rows.push({ row, ...rendered });
    result.bytes += bytes;
    result.excerpted ||= rendered.excerpted;
  }
  result.returned = result.rows.length;
  if (offset + result.returned < filtered.length) result.nextCursor = encodeCursor(offset + result.returned, revision);
  return result;
}

export function navigationMetadata(page: NavigationPage) {
  return { total: page.total, matched: page.matched, offset: page.offset, returned: page.returned,
    next_cursor: page.nextCursor ?? null, descriptions_excerpted: page.excerpted };
}

export function navigationFooter(context: NavigationContext, page: NavigationPage): string {
  const args = { skill_name: context.skillName, view: context.view, path: navigationPath(context.path),
    ...(context.view === "files" ? { max_depth: context.maxDepth ?? 2 } : {}),
    ...(context.query ? { query: context.query } : {}) };
  const shown = page.returned ? `${page.offset + 1}–${page.offset + page.returned}` : "0";
  const lines = [`Showing ${shown} of ${page.matched} matches (${page.total} total ${context.view === "files" ? "file/directory entries" : "sub-skills"}).`];
  if (page.nextCursor) lines.push(`Next page: list_skill_files(${JSON.stringify({ ...args, cursor: page.nextCursor })})`);
  if (page.nextCursor || context.query) lines.push(`Search the entire list before paging: list_skill_files(${JSON.stringify({ ...args, query: "topic or path" })})`);
  if (page.excerpted) lines.push("Navigation labels/descriptions are excerpts. Read the corresponding SKILL.md for the complete instructions.");
  return lines.join("\n");
}
