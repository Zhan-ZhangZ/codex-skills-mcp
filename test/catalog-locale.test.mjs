import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const catalog = JSON.parse(await readFile(new URL("app-src/catalog-en.json", root), "utf8"));
const HAN_RE = /[\u3400-\u9fff]/;

test("English catalog translates every current category and skill summary", () => {
  assert.equal(catalog.version, 1);
  assert.match(catalog.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(catalog.categories).length >= 19);
  assert.ok(Object.keys(catalog.skills).length >= 318);

  for (const [source, translated] of Object.entries(catalog.categories)) {
    assert.ok(source.trim());
    assert.ok(translated.trim());
    assert.doesNotMatch(translated, HAN_RE, source);
  }
  for (const [name, entry] of Object.entries(catalog.skills)) {
    assert.ok(name.trim());
    assert.ok(entry.source.trim());
    assert.ok(entry.description.trim());
    assert.doesNotMatch(entry.description, HAN_RE, name);
  }
});
