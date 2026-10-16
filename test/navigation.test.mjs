import assert from "node:assert/strict";
import test from "node:test";
import { navigationPage, subSkillNavigationRows, navigationPath } from "../dist/lib/navigation.js";

const context = { identity: "identity", skillName: "skill", view: "sub_skills" };

function rows(count = 240) {
  return subSkillNavigationRows(Array.from({ length: count }, (_, index) => ({
    name: `child-${String(index + 1).padStart(4, "0")}`,
    path: `nested/child-${String(index + 1).padStart(4, "0")}`,
    description: `Description ${index + 1}`,
  })));
}

test("navigation pages cover every row exactly once and obey the rendered byte budget", () => {
  const items = rows();
  let cursor;
  const seen = [];
  const pages = [];
  do {
    const page = navigationPage(items, context, { limit: 17, cursor });
    assert.equal(page.total, items.length);
    assert.equal(page.matched, items.length);
    assert.ok(page.rows.length > 0);
    assert.ok(page.bytes <= 12 * 1024);
    seen.push(...page.rows.map(item => item.row.path));
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, items.length);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(seen, items.map(item => item.path));
  assert.ok(pages.length > 1);
});

test("unicode navigation labels are excerpted on complete code points", () => {
  const name = "星".repeat(120) + "😀".repeat(30);
  const description = "文".repeat(500) + "😀".repeat(100);
  const [page] = [navigationPage(subSkillNavigationRows([
    { name, path: "unicode", description },
  ]), context)];
  const text = page.rows[0].text;
  assert.equal(page.excerpted, true);
  assert.ok(Buffer.byteLength(text) < 1_100);
  assert.ok(text.includes("…"));
  assert.doesNotMatch(text, /[\uD800-\uDBFF]…/);
});

test("queries cover complete descriptions even when the rendered label is excerpted", () => {
  const needle = "unusual-token-after-the-visible-summary";
  const items = subSkillNavigationRows([
    ...rows(120).map(item => item.row),
    { name: "target", path: "z/target", description: "short\n" + "x".repeat(1_000) + ` ${needle}` },
  ]);
  const page = navigationPage(items, { ...context, query: `TARGET ${needle}` }, { limit: 3 });
  assert.equal(page.matched, 1);
  assert.equal(page.returned, 1);
  assert.equal(page.rows[0].row.path, "z/target");
  assert.match(page.rows[0].text, /x{3,}[^\n]*…$/);
  assert.equal(page.nextCursor, undefined);
});

test("cursor is bound to filters, source identity and every complete row", () => {
  const items = rows();
  const first = navigationPage(items, context, { limit: 7 });
  const cursor = first.nextCursor;
  assert.ok(cursor);
  assert.throws(() => navigationPage(items, context, { limit: 7, cursor: `${cursor}x` }), /Invalid or expired navigation cursor/);
  assert.throws(() => navigationPage(items, { ...context, query: "description 9" }, { cursor }), /Invalid or expired navigation cursor/);
  assert.throws(() => navigationPage(items, { ...context, path: "changed" }, { cursor }), /Invalid or expired navigation cursor/);
  assert.throws(() => navigationPage(items, { ...context, view: "files" }, { cursor }), /Invalid or expired navigation cursor/);
  assert.throws(() => navigationPage([...items.slice(0, 8), { ...items[8], description: "changed" }, ...items.slice(9)], context, { cursor }), /Invalid or expired navigation cursor/);
});

test("navigation paths normalize safely without dropping an explicit subtree", () => {
  assert.equal(navigationPath("./alpha/./beta/"), "alpha/beta");
  assert.equal(navigationPath("."), "");
  assert.throws(() => navigationPath("/absolute"), /relative to the skill/);
  assert.throws(() => navigationPath("../outside"), /stay within the skill/);
  assert.throws(() => navigationPath("bad\\path"), /relative to the skill/);
});
