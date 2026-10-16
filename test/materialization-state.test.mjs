import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureSkillFetched, consumeSkillMaterialization, peekSkillMaterialization, readSkillCacheState } from '../dist/remote/github.js';

const sha = value => createHash('sha1').update(`blob ${Buffer.byteLength(value)}`).update(Buffer.from([0])).update(value).digest('hex');
function setup(t, { count = 4, indexed = false, complete = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'codex-materialized-'));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
  const config = { skillsDir: root, manifestPath: join(root, 'manifest.json'), isRemote: true,
    githubRepo: 'fixture/repo', githubBranch: 'main', githubPath: 'skills', githubToken: undefined,
    useOfficialMirror: true, hedgeEnabled: true, downloadConcurrency: 3, downloadTimeout: 100, manifestTTL: 0 };
  const entry = { name: 'demo', description: 'fixture', category: 'test', folder: 'demo', relative_path: './demo' };
  if (indexed) entry.file_index = { path: '.catalog/test.json', sha256: 'a'.repeat(64), file_count: count, total_bytes: count * 4 };
  const localPath = join(root, 'demo');
  fs.mkdirSync(localPath);
  const files = Array.from({ length: count }, (_, i) => ({
    path: i ? `nested/file-${i}.md` : 'SKILL.md', size: 4, sha: sha('good'), mode: '100644',
  }));
  for (const file of files) {
    const target = join(localPath, file.path);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, 'good');
  }
  const marker = { version: 1, files, source: { repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath },
    ...(complete ? { completedAt: new Date().toISOString() } : {}),
    ...(indexed ? { fileIndexSha256: entry.file_index.sha256 } : {}),
  };
  const markerPath = join(localPath, '.codex-skills.tree.json');
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  globalThis.fetch = async () => { throw new Error('fixture is offline'); };
  return { config, entry, localPath, files, marker, markerPath };
}

function trackFileStats(t, fixture) {
  const original = fs.statSync;
  const paths = new Set(fixture.files.map(file => join(fixture.localPath, file.path)));
  const calls = [];
  fs.statSync = (path, ...args) => {
    if (paths.has(String(path))) calls.push(String(path));
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.statSync = original; syncBuiltinESMExports(); });
  return calls;
}

test('a hot ensure returns one-use state and files without a second per-file scan', async t => {
  const fixture = setup(t, { count: 40, indexed: true });
  const calls = trackFileStats(t, fixture);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  assert.equal(calls.length, fixture.files.length);
  const result = consumeSkillMaterialization(fixture.config, fixture.entry, receipt);
  assert.equal(result.cache.complete, true);
  assert.equal(result.cache.catalogCurrent, true);
  assert.equal(result.cache.filesTotal, 40);
  assert.equal(result.cache.sizeBytes, 160);
  assert.deepEqual(result.files, fixture.files);
  assert.equal(calls.length, 40, 'receipt consumption must not restat the file tree');
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, { kind: 'skill-materialization' }), undefined);
});

test('every separate ensure still inspects every cached file', async t => {
  const fixture = setup(t, { count: 12 });
  const calls = trackFileStats(t, fixture);
  for (let i = 0; i < 3; i++) {
    const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
    assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt).cache.complete, true);
    assert.equal(calls.length, (i + 1) * fixture.files.length);
  }
});

test('explicit cache-state reporting still scans files and observes manual deletion', async t => {
  const fixture = setup(t);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  consumeSkillMaterialization(fixture.config, fixture.entry, receipt);
  fs.unlinkSync(join(fixture.localPath, 'SKILL.md'));
  const calls = trackFileStats(t, fixture);
  const state = readSkillCacheState(fixture.config, fixture.entry);
  assert.equal(state.complete, false);
  assert.deepEqual(state.filesMissing, ['SKILL.md']);
  assert.equal(calls.length, fixture.files.length);
});

test('receipts are bound to source, entry path, cache target and catalog digest', async t => {
  const fixture = setup(t, { indexed: true });
  const variants = [
    [{ ...fixture.config, githubRepo: 'other/repo' }, fixture.entry],
    [{ ...fixture.config, githubBranch: 'beta' }, fixture.entry],
    [{ ...fixture.config, githubPath: 'other' }, fixture.entry],
    [{ ...fixture.config, skillsDir: join(fixture.config.skillsDir, 'other') }, fixture.entry],
    [fixture.config, { ...fixture.entry, relative_path: './other' }],
    [fixture.config, { ...fixture.entry, file_index: { ...fixture.entry.file_index, sha256: 'b'.repeat(64) } }],
  ];
  for (const [config, entry] of variants) {
    const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
    assert.equal(consumeSkillMaterialization(config, entry, receipt), undefined);
    assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined, 'a rejected receipt is consumed too');
  }
});

test('replacing a marker with identical bytes invalidates its receipt', async t => {
  const fixture = setup(t);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  const replacement = `${fixture.markerPath}.replacement`;
  fs.writeFileSync(replacement, fs.readFileSync(fixture.markerPath));
  fs.renameSync(replacement, fixture.markerPath);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  assert.equal(readSkillCacheState(fixture.config, fixture.entry).complete, true);
});

test('marker deletion and symlink substitution invalidate receipts', async t => {
  const fixture = setup(t);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  fs.unlinkSync(fixture.markerPath);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  fs.writeFileSync(fixture.markerPath, JSON.stringify(fixture.marker));
  const second = await ensureSkillFetched(fixture.config, fixture.entry);
  const other = join(fixture.config.skillsDir, 'other-marker.json');
  fs.writeFileSync(other, JSON.stringify(fixture.marker));
  fs.unlinkSync(fixture.markerPath);
  fs.symlinkSync(other, fixture.markerPath);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, second), undefined);
  assert.equal(readSkillCacheState(fixture.config, fixture.entry).complete, false);
});

test('an active repair invalidates old receipts even before the marker changes', async t => {
  const fixture = setup(t);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  const markerBytes = fs.readFileSync(fixture.markerPath, 'utf8');
  fs.unlinkSync(join(fixture.localPath, 'SKILL.md'));
  let completeDownload;
  let started;
  const fetching = new Promise(resolve => { started = resolve; });
  globalThis.fetch = () => {
    started();
    return new Promise(resolve => { completeDownload = () => resolve(new Response('good')); });
  };
  const repair = ensureSkillFetched(fixture.config, fixture.entry);
  await fetching;
  assert.equal(fs.readFileSync(fixture.markerPath, 'utf8'), markerBytes);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  completeDownload();
  const repaired = consumeSkillMaterialization(fixture.config, fixture.entry, await repair);
  assert.equal(repaired.cache.complete, true);
  assert.equal(fs.readFileSync(fixture.markerPath, 'utf8'), markerBytes, 'repair can leave the marker unchanged');
});

test('a completed repair invalidates an earlier unused receipt even with an unchanged marker', async t => {
  const fixture = setup(t);
  const old = await ensureSkillFetched(fixture.config, fixture.entry);
  const markerBytes = fs.readFileSync(fixture.markerPath, 'utf8');
  fs.unlinkSync(join(fixture.localPath, 'SKILL.md'));
  globalThis.fetch = async () => new Response('good');
  const repaired = await ensureSkillFetched(fixture.config, fixture.entry);
  assert.equal(fs.readFileSync(fixture.markerPath, 'utf8'), markerBytes);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, old), undefined);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, repaired).cache.complete, true);
});

test('a failed repair returns no success receipt and invalidates prior snapshots', async t => {
  const fixture = setup(t);
  const previous = await ensureSkillFetched(fixture.config, fixture.entry);
  fs.unlinkSync(join(fixture.localPath, 'SKILL.md'));
  await assert.rejects(ensureSkillFetched(fixture.config, fixture.entry), /offline/);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, previous), undefined);
  assert.equal(readSkillCacheState(fixture.config, fixture.entry).complete, false);
});

test('an offline old catalog never produces a complete current-revision snapshot', async t => {
  const fixture = setup(t, { indexed: true });
  const next = { ...fixture.entry, file_index: { ...fixture.entry.file_index, sha256: 'b'.repeat(64) } };
  const receipt = await ensureSkillFetched(fixture.config, next);
  const result = consumeSkillMaterialization(fixture.config, next, receipt);
  assert.equal(result.cache.cached, true);
  assert.equal(result.cache.complete, false);
  assert.equal(result.cache.catalogCurrent, false);
  assert.deepEqual(result.files, fixture.files);
});

test('incomplete markers must verify existing hashes before producing complete snapshots', async t => {
  const fixture = setup(t, { complete: false });
  fs.writeFileSync(join(fixture.localPath, 'SKILL.md'), 'evil');
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('good'); };
  const result = consumeSkillMaterialization(fixture.config, fixture.entry, await ensureSkillFetched(fixture.config, fixture.entry));
  assert.equal(result.cache.complete, true);
  assert.ok(requests > 0);
  assert.equal(fs.readFileSync(join(fixture.localPath, 'SKILL.md'), 'utf8'), 'good');
});

test('failed incomplete materialization never creates a success receipt', async t => {
  const fixture = setup(t, { complete: false });
  fs.writeFileSync(join(fixture.localPath, 'SKILL.md'), 'evil');
  await assert.rejects(ensureSkillFetched(fixture.config, fixture.entry), /offline/);
  const state = readSkillCacheState(fixture.config, fixture.entry);
  assert.equal(state.complete, false);
  assert.equal(state.completedAt, undefined);
});

test('receipt epoch tracking is bounded and evicted receipts fall back to deep checks', async t => {
  const fixtures = [];
  for (let i = 0; i < 129; i++) {
    const fixture = setup(t, { count: 1 });
    fixtures.push({ ...fixture, receipt: await ensureSkillFetched(fixture.config, fixture.entry) });
  }
  assert.equal(consumeSkillMaterialization(fixtures[0].config, fixtures[0].entry, fixtures[0].receipt), undefined);
  const latest = fixtures.at(-1);
  assert.equal(consumeSkillMaterialization(latest.config, latest.entry, latest.receipt).cache.complete, true);
  assert.equal(readSkillCacheState(fixtures[0].config, fixtures[0].entry).complete, true);
});

test('peek permits repeated current-request inspection while consume remains one-use', async t => {
  const fixture = setup(t);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  const first = peekSkillMaterialization(fixture.config, fixture.entry, receipt);
  assert.equal(first.cache.complete, true);
  assert.equal(peekSkillMaterialization(fixture.config, fixture.entry, receipt), first);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), first);
  assert.equal(peekSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
});

test('marker replacement between peek and consume invalidates the prepared response', async t => {
  const fixture = setup(t);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  assert.equal(peekSkillMaterialization(fixture.config, fixture.entry, receipt).cache.complete, true);
  const next = `${fixture.markerPath}.next`;
  fs.writeFileSync(next, JSON.stringify({ ...fixture.marker, completedAt: '2026-01-01T00:00:00.000Z' }));
  fs.renameSync(next, fixture.markerPath);
  assert.equal(peekSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
});

test('a source change between peek and consume rejects the prepared response', async t => {
  const fixture = setup(t, { indexed: true });
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  assert.equal(peekSkillMaterialization(fixture.config, fixture.entry, receipt).cache.complete, true);
  fixture.config.githubBranch = 'changed-during-read';
  assert.equal(peekSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
});

test('a completed repair between peek and consume rejects the earlier response', async t => {
  const fixture = setup(t);
  const receipt = await ensureSkillFetched(fixture.config, fixture.entry);
  assert.equal(peekSkillMaterialization(fixture.config, fixture.entry, receipt).cache.complete, true);
  fs.unlinkSync(join(fixture.localPath, 'SKILL.md'));
  globalThis.fetch = async () => new Response('good');
  const repaired = await ensureSkillFetched(fixture.config, fixture.entry);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, receipt), undefined);
  assert.equal(consumeSkillMaterialization(fixture.config, fixture.entry, repaired).cache.complete, true);
});
