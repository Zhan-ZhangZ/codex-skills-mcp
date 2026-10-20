import assert from "node:assert/strict";
import test from "node:test";

const { preferredReadmeName, preferredReadmePath } = await import("../dist/lib/readme.js");

test("preferred README chooses Simplified Chinese before other language variants", () => {
  assert.equal(preferredReadmeName([
    "README.md",
    "README_EN.md",
    "README.zh-TW.md",
    "README.zh.md",
    "README.zh-CN.md",
  ]), "README.zh-CN.md");
  assert.equal(preferredReadmeName([
    "README.md",
    "README.zh.md",
    "README.zh-TW.md",
  ]), "README.zh.md");
});

test("preferred README handles common Chinese filename conventions", () => {
  for (const name of [
    "README.zh-CN.md",
    "README_zh-CN.md",
    "README-zh.md",
    "README_zh.md",
    "README.zh-TW.md",
    "README_CN.md",
    "README-cn.md",
    "README.中文.md",
    "README中文.md",
  ]) {
    assert.equal(preferredReadmeName(["README.md", name]), name);
  }
});

test("preferred README falls back to the neutral or English README", () => {
  assert.equal(preferredReadmeName(["README_EN.md", "README.md"]), "README.md");
  assert.equal(preferredReadmeName(["README_EN.md", "README_DETAILED.md"]), "README_EN.md");
  assert.equal(preferredReadmeName(["README-ja.md"]), undefined);
});

test("preferred README finds localized documentation below a missing root", () => {
  assert.equal(preferredReadmePath([
    "references/README.md",
    "references/README.zh-CN.md",
  ]), "references/README.zh-CN.md");
});

test("preferred README ranks any Chinese documentation above a root English file", () => {
  assert.equal(preferredReadmePath([
    "README.md",
    "docs/README_zh.md",
  ]), "docs/README_zh.md");
  assert.equal(preferredReadmePath([
    "references/README.md",
    "references/README_EN.md",
  ]), "references/README.md");
});
