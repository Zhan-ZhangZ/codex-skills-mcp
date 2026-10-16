import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ensureSkillFetched, ensureCategoryTree, fetchManifest, refreshManifestIfStale, readSkillCacheState } from "../dist/remote/github.js";
import { raceDownloadDeadline, DownloadDeadlineExceeded } from "../dist/lib/deadline.js";

const entry = { name: "demo", description: "fixture", category: "test", folder: "demo", relative_path: "demo" };
const sha = (content) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
const file = (path, content) => ({ path, size: Buffer.byteLength(content), sha: sha(content) });
const json = (value, headers) => new Response(JSON.stringify(value), { headers });
function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-remote-test-"));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
  return { skillsDir: root, manifestPath: join(root, "skills_manifest.json"), isRemote: true,
    githubRepo: "owner/repo", githubBranch: "main", githubPath: "skills", githubToken: undefined,
    useOfficialMirror: true, hedgeEnabled: true, downloadConcurrency: 3, downloadTimeout: 100,
    manifestTTL: 1000, manifestPollMs: 1000, softDeadlineMs: 55, hardDeadlineMs: 285, ...overrides };
}
function seed(config, contents, overrides = {}, skill = entry) {
  const dir = join(config.skillsDir, skill.relative_path);
  mkdirSync(dir, { recursive: true });
  for (const [path, value] of Object.entries(contents)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), value);
  }
  const marker = { version: 1, files: Object.entries(contents).map(([path, value]) => file(path, value)),
    completedAt: "2020-01-01T00:00:00.000Z", validatedAt: "2020-01-01T00:00:00.000Z",
    source: { repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath }, ...overrides };
  writeFileSync(join(dir, ".codex-skills.tree.json"), JSON.stringify(marker));
  return { dir, marker, markerPath: join(dir, ".codex-skills.tree.json") };
}
function mockRemote(tree, raw, calls = []) {
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: String(url), options });
    if (parsed.hostname === "api.github.com") {
      if (parsed.pathname.includes("/contents/")) return json([{ name: "demo", type: "dir", sha: "tree" }]);
      return json({ tree: tree.map((f) => ({ type: "blob", ...f })), truncated: false });
    }
    return raw(parsed, options);
  };
}

test("failed refresh preserves old bytes, deleted files, and completion marker", async (t) => {
  const config = setup(t);
  const old = seed(config, { "SKILL.md": "old", "removed.md": "keep" });
  mockRemote([file("SKILL.md", "new"), file("addition.md", "new addition")], (url) =>
    url.pathname.endsWith("SKILL.md") ? new Response("new") : new Response(null, { status: 503 }));
  await ensureSkillFetched(config, entry);
  assert.equal(readFileSync(join(old.dir, "SKILL.md"), "utf8"), "old");
  assert.equal(readFileSync(join(old.dir, "removed.md"), "utf8"), "keep");
  assert.deepEqual(JSON.parse(readFileSync(old.markerPath, "utf8")), old.marker);
  assert.equal(readdirSync(old.dir).some((name) => name.endsWith(".tmp")), false);
});

test("successful same-size SHA refresh atomically replaces and removes old files", async (t) => {
  const config = setup(t);
  const old = seed(config, { "SKILL.md": "old", "removed.md": "gone" });
  mockRemote([file("SKILL.md", "new")], () => new Response("new"));
  await ensureSkillFetched(config, entry);
  assert.equal(readFileSync(join(old.dir, "SKILL.md"), "utf8"), "new");
  assert.equal(existsSync(join(old.dir, "removed.md")), false);
  assert.equal(readSkillCacheState(config, entry).complete, true);
});

test("stale fastest mirror loses on SHA and no mirror receives a token", async (t) => {
  const config = setup(t, { githubToken: "TEST_TOKEN" });
  const calls = [];
  mockRemote([file("SKILL.md", "new")], async (url) => {
    if (url.hostname === "raw.githubusercontent.com") { await delay(10); return new Response("new"); }
    return new Response("old");
  }, calls);
  await ensureSkillFetched(config, entry);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "new");
  for (const call of calls) {
    const trusted = ["raw.githubusercontent.com", "api.github.com"].includes(new URL(call.url).hostname);
    assert.equal(call.options.headers.Authorization, trusted ? "Bearer TEST_TOKEN" : undefined);
  }
});

test("truncated transfers cannot create a complete cache", async (t) => {
  const config = setup(t);
  mockRemote([file("SKILL.md", "expected")], () => new Response("bad"));
  await assert.rejects(ensureSkillFetched(config, entry), /Size mismatch/);
  assert.equal(existsSync(join(config.skillsDir, "demo/SKILL.md")), false);
  assert.equal(readSkillCacheState(config, entry).complete, false);
});

test("timeout remains active after response headers arrive", async (t) => {
  const config = setup(t, { downloadTimeout: 20 });
  let aborted = 0;
  mockRemote([file("SKILL.md", "expected")], (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => { aborted++; controller.error(signal.reason); }, { once: true });
    },
  })));
  const start = Date.now();
  await assert.rejects(ensureSkillFetched(config, entry), /timed out/);
  assert.ok(aborted >= 4);
  assert.ok(Date.now() - start < 1000);
});

test("concurrent repairs share a single transfer", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  const cached = seed(config, { "SKILL.md": "ready" });
  rmSync(join(cached.dir, "SKILL.md"));
  let calls = 0;
  globalThis.fetch = async () => { calls++; await delay(15); return new Response("ready"); };
  await Promise.all(Array.from({ length: 8 }, () => ensureSkillFetched(config, entry)));
  assert.equal(calls, 1);
  assert.equal(readSkillCacheState(config, entry).complete, true);
});

test("same relative path in independent sources never shares a download", async (t) => {
  const first = setup(t);
  const second = { ...first, skillsDir: join(first.skillsDir, "other"), manifestPath: join(first.skillsDir, "other/manifest.json"), githubRepo: "owner/second" };
  globalThis.fetch = async (url) => {
    await delay(5);
    const content = String(url).includes("owner/second") ? "two" : "one";
    if (String(url).includes("api.github.com")) return String(url).includes("/contents/")
      ? json([{ name: "demo", type: "dir", sha: "tree" }])
      : json({ tree: [{ type: "blob", ...file("SKILL.md", content) }] });
    return new Response(content);
  };
  await Promise.all([ensureSkillFetched(first, entry), ensureSkillFetched(second, entry)]);
  assert.equal(readFileSync(join(first.skillsDir, "demo/SKILL.md"), "utf8"), "one");
  assert.equal(readFileSync(join(second.skillsDir, "demo/SKILL.md"), "utf8"), "two");
});

test("source switches re-list and replace same-size cached content", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  seed(config, { "SKILL.md": "old", "old-source.md": "obsolete" });
  const changed = { ...config, githubBranch: "beta" };
  mockRemote([file("SKILL.md", "new")], () => new Response("new"));
  await ensureSkillFetched(changed, entry);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "new");
  assert.equal(readSkillCacheState(changed, entry).complete, true);
  assert.equal(existsSync(join(config.skillsDir, "demo/old-source.md")), false);
});

test("manifest and tree traversal paths are rejected before writes", async (t) => {
  const config = setup(t);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected fetch"); };
  for (const path of ["../escape", "/absolute", "demo/../../escape", "demo\\escape"]) {
    await assert.rejects(ensureSkillFetched(config, { ...entry, relative_path: path }), /Invalid relative/);
  }
  assert.equal(calls, 0);
  mockRemote([file("../escape", "oops")], () => new Response("oops"));
  await assert.rejects(ensureSkillFetched(config, entry), /Invalid remote file tree/);
  assert.equal(existsSync(join(config.skillsDir, "escape")), false);
});

test("symlinked skill directories cannot redirect cache writes", async (t) => {
  const config = setup(t);
  const target = join(config.skillsDir, "outside");
  mkdirSync(target);
  symlinkSync(target, join(config.skillsDir, "demo"));
  await assert.rejects(ensureSkillFetched(config, entry), /Symlink/);
  assert.deepEqual(readdirSync(target), []);
});

test("force refresh overrides disabled TTL while malformed manifests preserve cache", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json([entry]); };
  assert.equal(await fetchManifest(config), true);
  assert.equal(await fetchManifest(config), false);
  assert.equal(calls, 1);
  assert.equal(await fetchManifest(config, true), true);
  assert.equal(calls, 2);
  globalThis.fetch = async () => json([{ name: "invalid" }]);
  await assert.rejects(fetchManifest(config, true), /failed validation/);
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), [entry]);
});

test("freshness polling is isolated per cache and records its source", async (t) => {
  const first = setup(t);
  const second = { ...first, skillsDir: join(first.skillsDir, "other"), manifestPath: join(first.skillsDir, "other/manifest.json") };
  let calls = 0;
  globalThis.fetch = async () => { calls++; await delay(5); return json([entry], { etag: "etag" }); };
  assert.deepEqual(await Promise.all([refreshManifestIfStale(first), refreshManifestIfStale(second)]), [true, true]);
  assert.equal(calls, 2);
  assert.ok(existsSync(second.manifestPath));
  assert.equal(await refreshManifestIfStale(second), false);
  assert.equal(calls, 2);
});

test("category single-flight keys include cache and source identity", async (t) => {
  const first = setup(t);
  const second = { ...first, skillsDir: join(first.skillsDir, "other"), githubBranch: "beta" };
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++; await delay(5);
    return String(url).includes("/contents/") ? json([{ name: "category", type: "dir", sha: "tree" }])
      : json({ tree: [{ type: "blob", ...file("demo/SKILL.md", "ready") }] });
  };
  const data = await Promise.all([ensureCategoryTree(first, "root/category"), ensureCategoryTree(second, "root/category")]);
  assert.ok(data.every(Boolean));
  assert.equal(calls, 4);
  assert.ok(existsSync(join(second.skillsDir, ".category-trees.json")));
});

test("nested skills resolve their full category-relative prefix", async (t) => {
  const config = setup(t);
  const nested = { ...entry, relative_path: "root/category/group/demo" };
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.github.com")) return String(url).includes("/contents/")
      ? json([{ name: "category", type: "dir", sha: "tree" }])
      : json({ tree: [{ type: "blob", ...file("group/demo/SKILL.md", "nested") }] });
    return new Response("nested");
  };
  await ensureSkillFetched(config, nested);
  assert.equal(readFileSync(join(config.skillsDir, nested.relative_path, "SKILL.md"), "utf8"), "nested");
});

test("deadline Infinity is disabled; timed-out background rejection stays handled", async () => {
  assert.equal(await raceDownloadDeadline(delay(10, "done"), Infinity, "hard"), "done");
  const background = delay(20).then(() => { throw new Error("late failure"); });
  await assert.rejects(raceDownloadDeadline(background, 1, "soft"), DownloadDeadlineExceeded);
  await delay(30);
});

test("304 retains cached manifest; identical 200 does not rebuild the index", async (t) => {
  const config = setup(t, { manifestPollMs: 1 });
  globalThis.fetch = async () => json([entry], { etag: "known-etag" });
  await fetchManifest(config);
  await delay(5);
  globalThis.fetch = async (_url, { headers }) => {
    assert.equal(headers["If-None-Match"], "known-etag");
    return new Response(null, { status: 304 });
  };
  assert.equal(await refreshManifestIfStale(config), false);
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), [entry]);
  await delay(5);
  globalThis.fetch = async () => json([entry]);
  assert.equal(await refreshManifestIfStale(config), false);
});

test("failed polling of a new source is throttled without reusing old validators", async (t) => {
  const config = setup(t);
  globalThis.fetch = async () => json([entry], { etag: "old-etag" });
  await fetchManifest(config);
  const changed = { ...config, githubBranch: "beta" };
  let calls = 0;
  globalThis.fetch = async (_url, { headers }) => {
    calls++;
    assert.equal(headers["If-None-Match"], undefined);
    return new Response(null, { status: 503 });
  };
  assert.equal(await refreshManifestIfStale(changed), false);
  assert.equal(await refreshManifestIfStale(changed), false);
  assert.equal(calls, 1);
});

test("a single-file skill is resolved from its parent contents listing", async (t) => {
  const config = setup(t);
  const single = { ...entry, relative_path: "guide.md" };
  globalThis.fetch = async (url) => String(url).includes("api.github.com")
    ? json([{ name: "guide.md", type: "file", size: 5, sha: sha("guide") }])
    : new Response("guide");
  await ensureSkillFetched(config, single);
  assert.equal(readFileSync(join(config.skillsDir, "guide.md/guide.md"), "utf8"), "guide");
});

test("reserved marker aliases in remote trees cannot overwrite metadata", async (t) => {
  const config = setup(t);
  mockRemote([file("./.codex-skills.tree.json", "bad")], () => new Response("bad"));
  await assert.rejects(ensureSkillFetched(config, entry), /Invalid remote file tree/);
});

test("offline startup serves a validated expired same-source manifest, forced refresh fails", async (t) => {
  const config = setup(t);
  globalThis.fetch = async () => json([entry]);
  assert.equal(await fetchManifest(config), true);
  utimesSync(config.manifestPath, new Date(0), new Date(0));
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await fetchManifest(config), false);
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), [entry]);
  await assert.rejects(fetchManifest(config, true), /All download nodes failed/);
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), [entry]);
});

test("offline startup never serves a cached manifest from another source", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  globalThis.fetch = async () => json([entry]);
  await fetchManifest(config);
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(fetchManifest({ ...config, githubBranch: "beta" }), /All download nodes failed/);
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), [entry]);
  const source = JSON.parse(readFileSync(join(config.skillsDir, ".codex-skills.source.json"), "utf8"));
  assert.equal(source.branch, "main");
});

test("a corrupt same-source cache is repaired even with TTL disabled", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  globalThis.fetch = async () => json([entry]);
  await fetchManifest(config);
  writeFileSync(config.manifestPath, JSON.stringify([{ name: "incomplete" }]));
  assert.equal(await fetchManifest(config), true);
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), [entry]);
  writeFileSync(config.manifestPath, "broken JSON");
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(fetchManifest(config), /All download nodes failed/);
});

test("explicit refresh rejects malformed JSON and preserves the existing manifest", async (t) => {
  const config = setup(t);
  globalThis.fetch = async () => json([entry]);
  await fetchManifest(config);
  globalThis.fetch = async () => new Response("not JSON");
  await assert.rejects(fetchManifest(config, true), /failed validation/);
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), [entry]);
});
