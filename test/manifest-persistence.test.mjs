import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fetchManifest, readManifestMeta, refreshManifestIfStale } from "../dist/remote/github.js";

const entry = { name: "demo", description: "current", category: "test", folder: "demo", relative_path: "demo" };
const content = JSON.stringify([entry]);
const digest = text => createHash("sha256").update(text).digest("hex");
function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-manifest-persistence-"));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); });
  return { skillsDir: root, manifestPath: join(root, "skills_manifest.json"), isRemote: true,
    githubRepo: "owner/repo", githubBranch: "main", githubPath: "skills", githubToken: "TEST_TOKEN",
    manifestTTL: 1, manifestPollMs: 1, downloadTimeout: 100, useOfficialMirror: true, hedgeEnabled: true, ...overrides };
}
const isRaw = url => new URL(url).hostname === "raw.githubusercontent.com";

test("API fallback persists endpoint/body validators and reuses its 304 across refreshes", async t => {
  const config = setup(t);
  globalThis.fetch = async (url, { headers }) => {
    if (isRaw(url)) throw new Error("raw unavailable");
    assert.equal(new URL(url).hostname, "api.github.com");
    assert.equal(headers.Accept, "application/vnd.github.raw+json");
    assert.equal(headers.Authorization, "Bearer TEST_TOKEN");
    return new Response(content, { headers: { etag: "api-etag" } });
  };
  assert.equal(await fetchManifest(config), true);
  const meta = readManifestMeta(config);
  assert.equal(meta.validators.contents.bodySha256, digest(content));
  assert.equal(meta.validators.contents.etag, "api-etag");
  assert.equal(meta.validators.raw, undefined);
  let calls = 0;
  globalThis.fetch = async (url, { headers }) => {
    calls++;
    if (isRaw(url)) {
      assert.equal(headers["If-None-Match"], undefined);
      throw new Error("raw unavailable");
    }
    assert.equal(headers["If-None-Match"], "api-etag");
    return new Response(null, { status: 304 });
  };
  await delay(5);
  assert.equal(await refreshManifestIfStale(config), false);
  assert.equal(calls, 2);
  assert.equal(readFileSync(config.manifestPath, "utf8"), content);
  assert.equal(await fetchManifest(config, true), true);
  assert.equal(calls, 4);
});

test("valid same-source cache is never downgraded to a mirror when both authorities fail", async t => {
  const config = setup(t);
  globalThis.fetch = async () => new Response(content);
  await fetchManifest(config);
  utimesSync(config.manifestPath, new Date(0), new Date(0));
  const hosts = [];
  globalThis.fetch = async url => {
    const host = new URL(url).hostname;
    hosts.push(host);
    if (host === "raw.githubusercontent.com" || host === "api.github.com") throw new Error("offline");
    return new Response(JSON.stringify([{ ...entry, description: "stale mirror" }]));
  };
  assert.equal(await fetchManifest(config), false);
  await assert.rejects(fetchManifest(config, true), /All download nodes failed/);
  await delay(5);
  assert.equal(await refreshManifestIfStale(config), false);
  assert.deepEqual(hosts, Array(3).fill(["raw.githubusercontent.com", "api.github.com"]).flat());
  assert.equal(readFileSync(config.manifestPath, "utf8"), content);
});

test("local body edits invalidate persisted validators even when JSON still parses", async t => {
  const config = setup(t);
  globalThis.fetch = async () => new Response(content, { headers: { etag: "old-etag" } });
  await fetchManifest(config);
  writeFileSync(config.manifestPath, JSON.stringify([{ ...entry, description: "local edit" }]));
  globalThis.fetch = async (_url, { headers }) => {
    assert.equal(headers["If-None-Match"], undefined);
    return new Response(content, { headers: { etag: "new-etag" } });
  };
  await fetchManifest(config, true);
  assert.equal(readFileSync(config.manifestPath, "utf8"), content);
  assert.equal(readManifestMeta(config).validators.raw.etag, "new-etag");
});

test("legacy unbound ETags upgrade with an unconditional response", async t => {
  const config = setup(t);
  globalThis.fetch = async () => new Response(content);
  await fetchManifest(config);
  writeFileSync(join(config.skillsDir, ".codex-skills.manifest.meta.json"), JSON.stringify({
    etag: "legacy-etag", lastModified: "Wed, 01 Jan 2020 00:00:00 GMT", validatedAt: 0,
  }));
  globalThis.fetch = async (_url, { headers }) => {
    assert.equal(headers["If-None-Match"], undefined);
    assert.equal(headers["If-Modified-Since"], undefined);
    return new Response(content, { headers: { etag: "bound-etag" } });
  };
  assert.equal(await refreshManifestIfStale(config), false);
  assert.equal(readManifestMeta(config).validators.raw.bodySha256, digest(content));
  assert.equal(readManifestMeta(config).validators.raw.etag, "bound-etag");
});

test("failed source-switch polling preserves old source metadata and throttles only that source", async t => {
  const config = setup(t, { manifestPollMs: 60_000 });
  globalThis.fetch = async () => new Response(content, { headers: { etag: "main-etag" } });
  await fetchManifest(config);
  const metaPath = join(config.skillsDir, ".codex-skills.manifest.meta.json");
  const previous = readFileSync(metaPath, "utf8");
  const changed = { ...config, githubBranch: "other" };
  let calls = 0;
  globalThis.fetch = async (_url, { headers }) => {
    calls++;
    assert.equal(headers["If-None-Match"], undefined);
    throw new Error("offline");
  };
  assert.equal(await refreshManifestIfStale(changed), false);
  assert.equal(await refreshManifestIfStale(changed), false);
  assert.equal(calls, 2);
  assert.equal(readFileSync(metaPath, "utf8"), previous);
  assert.equal(readManifestMeta(config).validators.raw.etag, "main-etag");
});

test("concurrent same-source polls share both authoritative requests", async t => {
  const config = setup(t);
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    await delay(5);
    if (isRaw(url)) throw new Error("raw unavailable");
    return new Response(content);
  };
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => refreshManifestIfStale(config))), Array(8).fill(true));
  assert.equal(calls, 2);
  assert.equal(readFileSync(config.manifestPath, "utf8"), content);
});
