import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ensureSkillFetched, ensureCategoryTree, readSkillCacheState } from '../dist/remote/github.js';
import { fetchRemoteManifest } from '../dist/remote/manifest-fetch.js';
import { runHttpRequest, readHttpBudgetState } from '../dist/remote/http-budget.js';

const content = 'good';
const blobSha = createHash('sha1').update('blob 4\0good').digest('hex');
const baseEntry = { name: 'demo', description: 'fixture', category: 'test', folder: 'demo', relative_path: 'demo' };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.ok(predicate(), 'expected transport state was not reached');
}
function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-http-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { skillsDir: root, manifestPath: join(root, 'skills_manifest.json'), isRemote: true,
    githubRepo: 'owner/repo', githubBranch: 'main', githubPath: 'skills',
    useOfficialMirror: true, hedgeEnabled: true, downloadConcurrency: 16, downloadTimeout: 10000,
    manifestTTL: 0, manifestPollMs: 0, ...overrides };
}
function seedMissing(config, name, count = 1, indexed = false) {
  const entry = { ...baseEntry, name, folder: name, relative_path: name };
  const files = Array.from({ length: count }, (_, i) => ({
    path: i === 0 ? 'SKILL.md' : `file-${i}.txt`, size: 4, sha: blobSha, mode: '100644',
  }));
  if (indexed) entry.file_index = { path: `.catalog/${'a'.repeat(64)}.json`,
    sha256: 'a'.repeat(64), file_count: count, total_bytes: count * 4 };
  mkdirSync(join(config.skillsDir, name), { recursive: true });
  writeFileSync(join(config.skillsDir, name, '.codex-skills.tree.json'), JSON.stringify({
    version: 1, files, completedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
    source: { repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath },
    ...(indexed ? { fileIndexSha256: entry.file_index.sha256 } : {}),
  }));
  return entry;
}
function controlledBodies(t) {
  const pending = new Set();
  let active = 0;
  let peak = 0;
  let calls = 0;
  let automatic = false;
  const response = (body = content) => {
    calls++; active++; peak = Math.max(peak, active);
    let finish;
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true; active--; pending.delete(finish);
      return true;
    };
    const stream = new ReadableStream({
      start(controller) {
        finish = () => {
          if (settle()) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); }
        };
        pending.add(finish);
      },
      cancel() { settle(); },
    });
    if (automatic) finish();
    return new Response(stream);
  };
  const finishAll = () => { automatic = true; for (const finish of [...pending]) finish(); };
  t.after(finishAll);
  return { response, finishAll, active: () => active, peak: () => peak, calls: () => calls };
}
async function occupy(t, kind, count) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const signal = new AbortController().signal;
  const tasks = Array.from({ length: count }, () => runHttpRequest({ kind, group: `held-${kind}`, signal }, () => gate));
  const finish = async () => { release(); await Promise.all(tasks); };
  t.after(finish);
  await flush();
  return finish;
}

test.beforeEach(() => {
  assert.equal(readHttpBudgetState().active, 0, 'previous transports must fully settle');
  assert.equal(readHttpBudgetState().queued, 0);
});

test('default single-skill fan-out retains the original 0/400ms schedule and holds body permits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = setup(t);
  const entry = seedMissing(config, 'single', 16);
  const bodies = controlledBodies(t);
  t.mock.method(globalThis, 'fetch', async () => bodies.response());
  const pending = ensureSkillFetched(config, entry);
  await until(() => bodies.calls() === 16);
  assert.equal(readHttpBudgetState().activeByKind.data, 16);
  t.mock.timers.tick(399); await flush();
  assert.equal(bodies.calls(), 16);
  t.mock.timers.tick(1); await until(() => bodies.calls() === 80);
  assert.equal(readHttpBudgetState().activeByKind.data, 80);
  assert.equal(readHttpBudgetState().queued, 0);
  bodies.finishAll();
  await pending; await flush();
  assert.equal(bodies.peak(), 80);
  assert.equal(readSkillCacheState(config, entry).complete, true);
  assert.equal(readHttpBudgetState().active, 0);
});

test('three real skill downloads share an 80-request data ceiling instead of 240 requests', async t => {
  const config = setup(t, { hedgeEnabled: false });
  const entries = ['one', 'two', 'three'].map(name => seedMissing(config, name, 16));
  const bodies = controlledBodies(t);
  t.mock.method(globalThis, 'fetch', async () => bodies.response());
  const pending = Promise.all(entries.map(entry => ensureSkillFetched(config, entry)));
  await until(() => readHttpBudgetState().queued === 160);
  assert.equal(bodies.calls(), 80);
  assert.equal(bodies.active(), 80, 'headers do not release body permits');
  assert.equal(readHttpBudgetState().queuedGroups, 2);
  bodies.finishAll();
  await pending; await flush();
  assert.equal(bodies.peak(), 80);
  assert.ok(entries.every(entry => readSkillCacheState(config, entry).complete));
  assert.equal(readHttpBudgetState().active, 0);
  assert.equal(readHttpBudgetState().queued, 0);
});

test('category API metadata completes while all 80 data permits are occupied', async t => {
  const config = setup(t);
  const release = await occupy(t, 'data', 80);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    assert.deepEqual(readHttpBudgetState().activeByKind, { data: 80, metadata: 1, manifest: 0 });
    return new Response(JSON.stringify(String(url).includes('/contents/')
      ? [{ name: 'category', type: 'dir', sha: 'tree' }]
      : { tree: [{ type: 'blob', path: 'demo/SKILL.md', size: 4, sha: blobSha }] }));
  });
  assert.ok(await ensureCategoryTree(config, 'root/category'));
  assert.equal(calls.length, 2);
  await release();
});

test('immutable catalog metadata proceeds under saturated data and queues only materialization', async t => {
  const config = setup(t);
  const data = JSON.stringify({ version: 1, skill_path: 'demo',
    files: [{ path: 'SKILL.md', size: 4, sha: blobSha, mode: '100644' }] });
  const hash = createHash('sha256').update(data).digest('hex');
  const entry = { ...baseEntry, file_index: { path: `.catalog/${hash}.json`, sha256: hash, file_count: 1, total_bytes: 4 } };
  const release = await occupy(t, 'data', 80);
  let catalogCalls = 0;
  let fileCalls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/.catalog/')) {
      catalogCalls++;
      assert.equal(readHttpBudgetState().activeByKind.metadata, 1);
      return new Response(data);
    }
    fileCalls++;
    return new Response(content);
  });
  const pending = ensureSkillFetched(config, entry);
  await until(() => readHttpBudgetState().queued === 1);
  assert.equal(catalogCalls, 1);
  assert.equal(fileCalls, 0);
  await release(); await pending; await flush();
  assert.equal(readSkillCacheState(config, entry).complete, true);
});

test('manifest retains dedicated capacity when data and ordinary metadata reach 84 requests', async t => {
  const config = setup(t);
  const releaseData = await occupy(t, 'data', 80);
  const releaseMetadata = await occupy(t, 'metadata', 4);
  t.mock.method(globalThis, 'fetch', async () => {
    assert.deepEqual(readHttpBudgetState().activeByKind, { data: 80, metadata: 4, manifest: 1 });
    return new Response(JSON.stringify([baseEntry]));
  });
  const result = await fetchRemoteManifest(config, { authoritativeTimeoutMs: 1000, allowMirrors: false });
  assert.deepEqual(result.entries, [baseEntry]);
  await releaseData(); await releaseMetadata();
});

test('queued file timeout removes every attempt and never starts late HTTP after admission frees', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = setup(t, { downloadTimeout: 100, hedgeEnabled: false });
  const entry = seedMissing(config, 'queued');
  const release = await occupy(t, 'data', 80);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(content); });
  const rejected = assert.rejects(ensureSkillFetched(config, entry), /timed out/);
  await until(() => readHttpBudgetState().queued === 5);
  t.mock.timers.tick(100);
  await rejected; await flush();
  assert.equal(readHttpBudgetState().queued, 0);
  assert.equal(calls, 0);
  await release(); await flush();
  assert.equal(calls, 0);
});

test('queued manifest deadline aborts both candidates without fetching after capacity frees', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = setup(t);
  const release = await occupy(t, 'manifest', 88);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify([baseEntry])); });
  const rejected = assert.rejects(fetchRemoteManifest(config,
    { authoritativeTimeoutMs: 100, hedgeDelayMs: 10, allowMirrors: false }), /timed out/);
  await until(() => readHttpBudgetState().queued === 1);
  t.mock.timers.tick(10); await flush();
  assert.equal(readHttpBudgetState().queued, 2);
  t.mock.timers.tick(90); await rejected; await flush();
  assert.equal(readHttpBudgetState().queued, 0);
  await release(); await flush();
  assert.equal(calls, 0);
});

test('slow file body cancellation keeps permits after the caller deadline until cancellation settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = setup(t, { downloadTimeout: 100, hedgeEnabled: false });
  const entry = seedMissing(config, 'slow-cancel');
  let finishCancellation;
  const cancellation = new Promise(resolve => { finishCancellation = resolve; });
  t.after(finishCancellation);
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled++; return cancellation; },
  })));
  const rejected = assert.rejects(ensureSkillFetched(config, entry), /timed out/);
  await until(() => readHttpBudgetState().activeByKind.data === 5);
  await flush();
  t.mock.timers.tick(100); await rejected; await flush();
  assert.equal(cancelled, 5);
  assert.equal(readHttpBudgetState().activeByKind.data, 5);
  finishCancellation(); await until(() => readHttpBudgetState().active === 0);
});

test('slow manifest body cancellation holds the shared permit through underlying cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = setup(t);
  let finishCancellation;
  const cancellation = new Promise(resolve => { finishCancellation = resolve; });
  t.after(finishCancellation);
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled++; return cancellation; },
  })));
  const rejected = assert.rejects(fetchRemoteManifest(config,
    { authoritativeTimeoutMs: 100, hedgeDelayMs: 10, allowMirrors: false }), /timed out/);
  await until(() => readHttpBudgetState().activeByKind.manifest === 1);
  t.mock.timers.tick(10); await flush();
  assert.equal(readHttpBudgetState().activeByKind.manifest, 2);
  t.mock.timers.tick(90); await rejected; await flush();
  assert.equal(cancelled, 2);
  assert.equal(readHttpBudgetState().activeByKind.manifest, 2);
  finishCancellation(); await until(() => readHttpBudgetState().active === 0);
});

test('immutable historical blob fallback shares the data budget and verifies its full body', async t => {
  const config = setup(t, { hedgeEnabled: false });
  const entry = seedMissing(config, 'historical', 1, true);
  const bodies = controlledBodies(t);
  let blobCalls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/git/blobs/')) {
      blobCalls++;
      assert.deepEqual(readHttpBudgetState().activeByKind, { data: 1, metadata: 0, manifest: 0 });
      return bodies.response();
    }
    return new Response('evil');
  });
  const pending = ensureSkillFetched(config, entry);
  await until(() => blobCalls === 1);
  assert.equal(readHttpBudgetState().activeByKind.data, 1);
  bodies.finishAll(); await pending; await flush();
  assert.equal(readFileSync(join(config.skillsDir, 'historical/SKILL.md'), 'utf8'), content);
  assert.equal(readHttpBudgetState().active, 0);
});

test('a SHA-invalid historical blob releases its data permit without materializing bytes', async t => {
  const config = setup(t, { hedgeEnabled: false });
  const entry = seedMissing(config, 'bad-historical', 1, true);
  t.mock.method(globalThis, 'fetch', async () => new Response('evil'));
  await assert.rejects(ensureSkillFetched(config, entry), /immutable blob fallback.*Git blob SHA mismatch/);
  await flush();
  assert.equal(readSkillCacheState(config, entry).complete, false);
  assert.equal(readHttpBudgetState().active, 0);
});

// Last: the process-wide budget intentionally never shrinks after valid expansion.
test('explicit concurrency expands shared capacity once, rejects invalid values, and caps it at 328', async () => {
  const signal = new AbortController().signal;
  const run = concurrency => runHttpRequest({ kind: 'data', group: 'expansion', signal }, async () => {}, concurrency);
  for (const invalid of [undefined, 0, -1, 16, 16.5, 65, 1000, NaN, Infinity]) await run(invalid);
  assert.equal(readHttpBudgetState().limits.capacity, 88);
  await run(20);
  assert.equal(readHttpBudgetState().limits.capacity, 108);
  await run(17); await run(16);
  assert.equal(readHttpBudgetState().limits.capacity, 108);
  await run(64);
  assert.deepEqual(readHttpBudgetState().limits, { capacity: 328, metadataReserve: 8, manifestReserve: 4 });
  await run(65); await run(1);
  assert.equal(readHttpBudgetState().limits.capacity, 328);
});
