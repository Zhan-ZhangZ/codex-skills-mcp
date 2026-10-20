import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, utimesSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ensureSkillFetched, ensureCategoryTree, fetchManifest, refreshManifestIfStale, readSkillCacheState, isSkillCachedLight } from "../dist/remote/github.js";
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
  assert.equal(calls, 2, "raw and Contents API each fail once, then the source is throttled");
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
  for (const path of ["./.codex-skills.tree.json", ".codex-skills.tree.json", ".codex-skills.tree.json/payload"]) {
    mockRemote([file(path, "bad")], () => new Response("bad"));
    await assert.rejects(ensureSkillFetched(config, entry), /Invalid remote file tree/);
  }
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

test("immutable manifest catalogs bypass GitHub tree APIs", async (t) => {
  const config = setup(t, { manifestTTL: 60_000 });
  const content = "# Demo skill\n";
  const files = [file("SKILL.md", content)];
  const catalogBody = Buffer.from(JSON.stringify({
    version: 1, skill_path: "./demo", files: files.map((item) => ({ ...item, mode: "100644" })),
  }) + "\n");
  const catalogSha256 = createHash("sha256").update(catalogBody).digest("hex");
  const indexed = {
    ...entry,
    relative_path: "./demo",
    file_index: { path: `.catalog/${catalogSha256}.json`, sha256: catalogSha256,
      file_count: files.length, total_bytes: files[0].size },
  };
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.includes(`/.catalog/${catalogSha256}.json`)) return new Response(catalogBody);
    if (value.endsWith("/demo/SKILL.md")) return new Response(content);
    throw new Error(`unexpected URL: ${value}`);
  };

  await ensureSkillFetched(config, indexed);
  const requestCount = urls.length;
  assert.equal(readFileSync(join(config.skillsDir, "demo", "SKILL.md"), "utf8"), content);
  assert.deepEqual(JSON.parse(readFileSync(join(config.skillsDir, ".catalog", `${catalogSha256}.json`), "utf8")).files,
      files.map((item) => ({ ...item, mode: "100644" })));
  assert.ok(urls.length >= 2);
  assert.ok(!urls.some((url) => url.includes("api.github.com")));

  await ensureSkillFetched(config, indexed);
  assert.equal(urls.length, requestCount, "fresh complete cache must not issue network requests");

  writeFileSync(join(config.skillsDir, ".catalog", `${catalogSha256}.json`), "corrupt");
  config.manifestTTL = 1;
  await delay(5);
  await ensureSkillFetched(config, indexed);
  assert.equal(readFileSync(join(config.skillsDir, ".catalog", `${catalogSha256}.json`), "utf8"), catalogBody.toString("utf8"));
});

test("a corrupt immutable catalog falls back to the GitHub tree API", async (t) => {
  const config = setup(t);
  const content = "# API fallback\n";
  const catalogSha256 = createHash("sha256").update("bad catalog").digest("hex");
  const indexed = {
    ...entry, relative_path: "./demo",
    file_index: { path: `.catalog/${catalogSha256}.json`, sha256: catalogSha256, file_count: 1, total_bytes: content.length },
  };
  const treeSha = "0123456789abcdef0123456789abcdef01234567";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes(`/.catalog/${catalogSha256}.json`)) return new Response("bad catalog");
    if (value.includes("api.github.com")) {
      if (value.includes(`/git/trees/${treeSha}`)) {
        return new Response(JSON.stringify({ tree: [{ type: "blob", path: "SKILL.md", sha: sha(content), size: Buffer.byteLength(content) }] }));
      }
      return new Response(JSON.stringify([{ name: "demo", type: "dir", sha: treeSha }]));
    }
    if (value.endsWith("/demo/SKILL.md")) return new Response(content);
    throw new Error(`unexpected URL: ${value}`);
  };

  await ensureSkillFetched(config, indexed);
  assert.equal(readFileSync(join(config.skillsDir, "demo", "SKILL.md"), "utf8"), content);
  assert.ok(readSkillCacheState(config, indexed).cached);
  assert.equal(readSkillCacheState(config, indexed).catalogCurrent, false);
  assert.equal(readSkillCacheState(config, indexed).complete, false, "API fallback cannot attest a corrupt catalog");
});

function indexedSkill(contents, transform = (files) => files, skillPath = "./demo") {
  const files = transform(Object.entries(contents).map(([path, content]) => ({ ...file(path, content), mode: "100644" })));
  const data = Buffer.from(JSON.stringify({ version: 1, skill_path: skillPath, files }) + "\n");
  const hash = createHash("sha256").update(data).digest("hex");
  return { data, entry: { ...entry, relative_path: skillPath, file_index: {
    path: `.catalog/${hash}.json`, sha256: hash, file_count: files.length,
    total_bytes: files.reduce((total, item) => total + item.size, 0),
  } } };
}

test("catalog digest changes refresh a complete cache before TTL expiry", async (t) => {
  const config = setup(t, { manifestTTL: 60_000 });
  const initial = indexedSkill({ "SKILL.md": "old" });
  const updated = indexedSkill({ "SKILL.md": "new" });
  let current = initial;
  let content = "old";
  let catalogCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.github.com")) throw new Error("Catalog path must not need GitHub API");
    if (String(url).includes("/.catalog/")) { catalogCalls++; return new Response(current.data); }
    return new Response(content);
  };
  await ensureSkillFetched(config, initial.entry);
  current = updated;
  content = "new";
  await ensureSkillFetched(config, updated.entry);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "new");
  assert.equal(catalogCalls, 2);
});

test("a changed catalog supersedes an interrupted old download marker", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  const initial = indexedSkill({ "SKILL.md": "old", "old-only.md": "old reference" });
  const updated = indexedSkill({ "SKILL.md": "new", "new-only.md": "new reference" });
  globalThis.fetch = async (url) => {
    if (String(url).includes("/.catalog/")) return new Response(initial.data);
    if (String(url).endsWith("/SKILL.md")) return new Response("old");
    return new Response(null, { status: 503 });
  };
  await assert.rejects(ensureSkillFetched(config, initial.entry), /downloads failed/);
  globalThis.fetch = async (url) => {
    if (String(url).includes("/.catalog/")) return new Response(updated.data);
    if (String(url).endsWith("/SKILL.md")) return new Response("new");
    if (String(url).endsWith("/new-only.md")) return new Response("new reference");
    throw new Error(`Unexpected obsolete download: ${url}`);
  };
  await ensureSkillFetched(config, updated.entry);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "new");
  assert.equal(readFileSync(join(config.skillsDir, "demo/new-only.md"), "utf8"), "new reference");
  assert.equal(existsSync(join(config.skillsDir, "demo/old-only.md")), false);
  assert.ok(readSkillCacheState(config, updated.entry).complete);
});

test("a corrupt fastest catalog mirror cannot suppress healthy raw nodes", async (t) => {
  const config = setup(t);
  const indexed = indexedSkill({ "SKILL.md": "good" });
  let apiCalls = 0;
  let healthyCatalogCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com") { apiCalls++; return new Response(null, { status: 403 }); }
    if (parsed.pathname.includes("/.catalog/")) {
      if (parsed.hostname === "gh.251716.xyz") return new Response("corrupt catalog");
      healthyCatalogCalls++;
      return new Response(indexed.data);
    }
    return new Response("good");
  };
  await ensureSkillFetched(config, indexed.entry);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "good");
  assert.ok(healthyCatalogCalls > 0);
  assert.equal(apiCalls, 0);
});

test("catalog records missing Git blob SHA are rejected before materialization", async (t) => {
  const config = setup(t);
  const indexed = indexedSkill({ "SKILL.md": "good" }, (files) => files.map(({ sha: _sha, ...item }) => item));
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.github.com")) return new Response(null, { status: 403 });
    return new Response(String(url).includes("/.catalog/") ? indexed.data : "evil");
  };
  await assert.rejects(ensureSkillFetched(config, indexed.entry));
  assert.equal(existsSync(join(config.skillsDir, "demo/SKILL.md")), false);
});

test("catalog records missing Git file mode are rejected before materialization", async (t) => {
  const config = setup(t);
  const indexed = indexedSkill({ "SKILL.md": "good" }, (files) => files.map(({ mode: _mode, ...item }) => item));
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.github.com")) return new Response(null, { status: 403 });
    return new Response(String(url).includes("/.catalog/") ? indexed.data : "good");
  };
  await assert.rejects(ensureSkillFetched(config, indexed.entry));
  assert.equal(existsSync(join(config.skillsDir, "demo/SKILL.md")), false);
});

test("a catalog-pinned blob remains downloadable after the branch advances", async (t) => {
  const config = setup(t, { githubToken: "TEST_TOKEN" });
  const indexed = indexedSkill({ "SKILL.md": "old" });
  let blobCalls = 0;
  globalThis.fetch = async (url, { headers } = {}) => {
    const value = String(url);
    if (value.includes("/.catalog/")) return new Response(indexed.data);
    if (value.endsWith(`/git/blobs/${sha("old")}`)) {
      blobCalls++;
      assert.equal(headers.Accept, "application/vnd.github.raw+json");
      assert.equal(headers.Authorization, "Bearer TEST_TOKEN");
      return new Response("old");
    }
    return new Response("new");
  };
  await ensureSkillFetched(config, indexed.entry);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "old");
  assert.equal(blobCalls, 1);
});

test("immutable blob fallback rejects bytes with the wrong Git SHA", async (t) => {
  const config = setup(t);
  const indexed = indexedSkill({ "SKILL.md": "old" });
  globalThis.fetch = async (url) => new Response(String(url).includes("/.catalog/") ? indexed.data : "bad");
  await assert.rejects(ensureSkillFetched(config, indexed.entry), /SHA mismatch/);
  assert.equal(existsSync(join(config.skillsDir, "demo/SKILL.md")), false);
  assert.equal(readSkillCacheState(config, indexed.entry).complete, false);
});

test("catalog executable modes persist and permission-only repair needs no network", { skip: process.platform === "win32" }, async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  const script = "#!/bin/sh\necho ready\n";
  const indexed = indexedSkill({ "SKILL.md": "ready", "run.sh": script }, (files) =>
    files.map((item) => ({ ...item, mode: item.path === "run.sh" ? "100755" : "100644" })));
  globalThis.fetch = async (url) => new Response(String(url).includes("/.catalog/")
    ? indexed.data : String(url).endsWith("/run.sh") ? script : "ready");
  await ensureSkillFetched(config, indexed.entry);
  const path = join(config.skillsDir, "demo/run.sh");
  assert.equal(statSync(path).mode & 0o777, 0o755);
  chmodSync(path, 0o644);
  globalThis.fetch = async () => { throw new Error("Permission repair should stay offline"); };
  await ensureSkillFetched(config, indexed.entry);
  assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.ok(readSkillCacheState(config, indexed.entry).complete);
});

test("cache badges reject a superseded catalog identity", async (t) => {
  const config = setup(t);
  const old = indexedSkill({ "SKILL.md": "old" });
  const next = indexedSkill({ "SKILL.md": "new" });
  globalThis.fetch = async (url) => new Response(String(url).includes("/.catalog/") ? old.data : "old");
  await ensureSkillFetched(config, old.entry);
  assert.equal(readSkillCacheState(config, old.entry).complete, true);
  assert.equal(isSkillCachedLight(config, old.entry), true);
  assert.equal(readSkillCacheState(config, next.entry).complete, false);
  assert.equal(isSkillCachedLight(config, next.entry), false);
});

test("legacy completed markers adopt a catalog identity even with TTL disabled", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  seed(config, { "SKILL.md": "old" });
  const indexed = indexedSkill({ "SKILL.md": "new" });
  globalThis.fetch = async (url) => new Response(String(url).includes("/.catalog/") ? indexed.data : "new");
  await ensureSkillFetched(config, indexed.entry);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "new");
  assert.ok(isSkillCachedLight(config, indexed.entry));
});

test("concurrent callers with different catalog digests recheck after the inflight download", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  const old = indexedSkill({ "SKILL.md": "old" });
  const next = indexedSkill({ "SKILL.md": "new" });
  let releaseOld;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseOld = resolve; });
  let fileCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes(old.entry.file_index.path)) return new Response(old.data);
    if (value.includes(next.entry.file_index.path)) return new Response(next.data);
    fileCalls++;
    if (fileCalls === 1) { markStarted(); await blocked; return new Response("old"); }
    return new Response("new");
  };
  const first = ensureSkillFetched(config, old.entry);
  await started;
  const second = ensureSkillFetched(config, next.entry);
  releaseOld();
  await Promise.all([first, second]);
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "new");
  assert.equal(isSkillCachedLight(config, next.entry), true);
  assert.equal(fileCalls, 2);
});

test("retry after a failed forced fetch cannot promote unverified same-size local bytes", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  const indexed = indexedSkill({ "SKILL.md": "new" });
  const local = join(config.skillsDir, "demo/SKILL.md");
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, "old");
  globalThis.fetch = async (url) => String(url).includes("/.catalog/")
    ? new Response(indexed.data) : new Response(null, { status: 503 });
  await assert.rejects(ensureSkillFetched(config, indexed.entry), /downloads failed/);
  assert.equal(readFileSync(local, "utf8"), "old");
  assert.equal(readSkillCacheState(config, indexed.entry).complete, false);
  let fileCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/.catalog/")) return new Response(indexed.data);
    fileCalls++;
    return new Response("new");
  };
  await ensureSkillFetched(config, indexed.entry);
  assert.equal(readFileSync(local, "utf8"), "new");
  assert.ok(fileCalls > 0, "same-size preexisting bytes have not passed the catalog SHA check");
  assert.equal(readSkillCacheState(config, indexed.entry).complete, true);
});

test("stale category fallback must not permanently attest a new catalog digest", async (t) => {
  const config = setup(t, { manifestTTL: 0 });
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const skillPath = "./root/category/demo";
  const old = indexedSkill({ "SKILL.md": "old" }, undefined, skillPath);
  const next = indexedSkill({ "SKILL.md": "new" }, undefined, skillPath);
  globalThis.fetch = async (url) => new Response(String(url).includes("/.catalog/") ? old.data : "old");
  await ensureSkillFetched(config, old.entry);
  writeFileSync(join(config.skillsDir, ".category-trees.json"), JSON.stringify({
    "root/category": { fetchedAt: Date.now(), truncated: false,
      source: { repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath },
      entries: [file("demo/SKILL.md", "old")],
    },
  }));
  let failedCalls = 0;
  globalThis.fetch = async () => { failedCalls++; return new Response(null, { status: 503 }); };
  await ensureSkillFetched(config, next.entry);
  assert.equal(readFileSync(join(config.skillsDir, skillPath, "SKILL.md"), "utf8"), "old");
  assert.equal(isSkillCachedLight(config, next.entry), false, "fallback tree has not been verified against the new catalog");
  assert.equal(readSkillCacheState(config, next.entry).catalogCurrent, false);
  const firstAttemptCalls = failedCalls;
  await ensureSkillFetched(config, next.entry);
  assert.equal(failedCalls, firstAttemptCalls, "failed catalog refresh is backed off");
  now += 10 * 60 * 1000 + 1;
  let recoveredCalls = 0;
  globalThis.fetch = async (url) => {
    recoveredCalls++;
    return new Response(String(url).includes("/.catalog/") ? next.data : "new");
  };
  await ensureSkillFetched(config, next.entry);
  assert.ok(recoveredCalls > 0, "catalog is retried after backoff even with TTL disabled");
  assert.equal(readFileSync(join(config.skillsDir, skillPath, "SKILL.md"), "utf8"), "new");
  assert.equal(readSkillCacheState(config, next.entry).catalogCurrent, true);
  assert.equal(readSkillCacheState(config, next.entry).complete, true);
  assert.equal(isSkillCachedLight(config, next.entry), true);
});

test("catalog refresh races verified mirrors without waiting for a hanging direct node", async (t) => {
  const config = setup(t, { manifestTTL: 0, downloadTimeout: 2000 });
  const old = indexedSkill({ "SKILL.md": "old" });
  const next = indexedSkill({ "SKILL.md": "new" });
  globalThis.fetch = async (url) => new Response(String(url).includes("/.catalog/") ? old.data : "old");
  await ensureSkillFetched(config, old.entry);
  let directCalls = 0;
  globalThis.fetch = async (url, { signal } = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/.catalog/")) return new Response(next.data);
    if (parsed.hostname === "raw.githubusercontent.com") {
      directCalls++;
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (parsed.hostname === "gh.251716.xyz") return new Response("new");
    throw new Error(`Unexpected fallback node: ${url}`);
  };
  const start = performance.now();
  await ensureSkillFetched(config, next.entry);
  assert.ok(performance.now() - start < 500, "verified mirror update should finish before the hedge window");
  assert.equal(directCalls, 0, "fast verified mirror leaves the direct connection unused");
  assert.equal(readFileSync(join(config.skillsDir, "demo/SKILL.md"), "utf8"), "new");
});
