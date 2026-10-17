import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SkillLoader } from '../dist/loader/index.js';

const entry = { name: 'navigation-demo', description: 'fixture', category: 'test', folder: 'demo', relative_path: './demo' };
const child = (name) => ['---', 'name: ' + name, 'description: nested instructions', '---', 'Execute the task.', ''].join('\n');
const sha = body => createHash('sha1').update('blob ' + Buffer.byteLength(body)).update(Buffer.from([0])).update(body).digest('hex');

function fixture(t, contents, remote = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'codex-navigation-'));
  const config = { skillsDir: root, manifestPath: join(root, 'skills_manifest.json'), isRemote: remote,
    githubRepo: 'navigation/fixture', githubBranch: 'main', githubPath: 'skills', githubToken: 'SECRET_TOKEN',
    useOfficialMirror: false, hedgeEnabled: false, downloadConcurrency: 3, downloadTimeout: 100,
    manifestTTL: 0, manifestPollMs: 0, softDeadlineMs: 0, hardDeadlineMs: 0 };
  const directory = join(root, 'demo');
  const files = Object.entries(contents).map(([path, content]) => {
    const target = join(directory, path);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    fs.chmodSync(target, 0o644);
    return { path, size: Buffer.byteLength(content), sha: sha(content), mode: '100644' };
  });
  const marker = { version: 1, files, completedAt: new Date().toISOString(),
    source: { repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath } };
  const save = () => fs.writeFileSync(join(directory, '.codex-skills.tree.json'), JSON.stringify(marker));
  save();
  t.mock.method(globalThis, 'fetch', () => assert.fail('complete navigation must stay offline'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { config, directory, marker, save, loader: new SkillLoader(config, [entry]) };
}

function rejectRootReads(t, loader) {
  t.mock.method(loader, 'rootInstructions', () => assert.fail('navigation must not read root instructions'));
  t.mock.method(loader, 'detectDependencies', () => assert.fail('navigation must not detect dependencies'));
}

async function inspectReads(operation) {
  const reads = [], directories = [];
  const originalRead = fs.promises.readFile, originalDirectory = fs.promises.readdir;
  fs.promises.readFile = (...args) => { reads.push(String(args[0])); return originalRead(...args); };
  fs.promises.readdir = (...args) => { directories.push(String(args[0])); return originalDirectory(...args); };
  syncBuiltinESMExports();
  try { return { result: await operation(), reads, directories }; } finally {
    fs.promises.readFile = originalRead;
    fs.promises.readdir = originalDirectory;
    syncBuiltinESMExports();
  }
}

for (const remote of [true, false]) {
  const label = remote ? 'remote' : 'local';
  test(label + ' files navigation reads no instructions and stops at the displayed depth', async t => {
    const { loader } = fixture(t, { 'SKILL.md': '# root', 'requirements.txt': 'package',
      'alpha/SKILL.md': child('alpha'), 'alpha/deep/SKILL.md': child('deep') }, remote);
    rejectRootReads(t, loader);
    if (remote) t.mock.method(loader, 'catalogSummary', () => assert.fail('files must not compute summaries'));
    const { result, reads, directories } = await inspectReads(() => loader.readNavigation(entry, { view: 'files', maxDepth: 0 }));
    assert.deepEqual(reads, []);
    assert.deepEqual(result.sub_skills, []);
    assert.equal(result.cache.complete, true);
    assert.deepEqual(result.files.find(node => node.name === 'alpha'), { name: 'alpha', type: 'directory' });
    assert.equal(result.files.find(node => node.name === 'SKILL.md').size_bytes, 6);
    assert.equal('instructions' in result, false);
    assert.equal('dependencies' in result, false);
    assert.equal(directories.length, remote ? 0 : 1);
  });

  test(label + ' subskill navigation discovers every depth and filters a complete subtree', async t => {
    const deep = 'alpha/a/b/c/d/e/f/g';
    const { loader, directory } = fixture(t, { 'SKILL.md': '# root',
      'alpha/SKILL.md': child('alpha'), [deep + '/SKILL.md']: child('deep'),
      'alpha-extra/SKILL.md': child('sibling'), '.hidden/SKILL.md': child('hidden'),
      'node_modules/dep/SKILL.md': child('excluded dependency') }, remote);
    rejectRootReads(t, loader);
    const { result, reads } = await inspectReads(() => loader.readNavigation(entry, { view: 'sub_skills', maxDepth: 0 }));
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.sub_skills.map(item => item.name), ['hidden', 'alpha', 'deep', 'sibling']);
    assert.ok(reads.every(path => path !== join(directory, 'SKILL.md')));
    const scoped = await loader.readNavigation(entry, { view: 'sub_skills', path: './alpha/./', maxDepth: 0 });
    assert.deepEqual(scoped.sub_skills.map(item => item.path), ['alpha', deep]);
    assert.equal(scoped.identity, result.identity, 'filters are bound separately by the pager');
  });

  test(label + ' sub-skill discovery excludes tests, fixtures and examples', async t => {
    const { loader } = fixture(t, {
      'SKILL.md': '# root',
      'skills/real/SKILL.md': child('real'),
      'tests/fixtures/fake/SKILL.md': child('test fixture'),
      'src/eval/providers/demo/fixtures/fake/SKILL.md': child('eval fixture'),
      'benchmarks/demo/SKILL.md': child('benchmark'),
      'examples/demo/SKILL.md': child('example'),
    }, remote);
    const skills = await loader.readNavigation(entry, { view: 'sub_skills' });
    assert.deepEqual(skills.sub_skills.map(item => item.name), ['real']);
    const files = await loader.readNavigation(entry, { view: 'files' });
    assert.ok(files.files.some(node => node.name === 'tests'));
    assert.ok(files.files.some(node => node.name === 'examples'));
  });

  test(label + ' readSkill and navigation share identity and unbounded subskill discovery', async t => {
    const deep = 'one/two/three/four/five/six/seven';
    const { loader } = fixture(t, { 'SKILL.md': '# Entire instructions', [deep + '/SKILL.md']: child('deep') }, remote);
    const full = await loader.readSkill(entry);
    const files = await loader.readNavigation(entry, { view: 'files' });
    const skills = await loader.readNavigation(entry, { view: 'sub_skills' });
    assert.equal(full.navigationIdentity, files.identity);
    assert.equal(skills.identity, files.identity);
    assert.deepEqual(full.structure.files, files.files);
    assert.deepEqual(full.structure.sub_skills, skills.sub_skills);
    assert.equal(skills.sub_skills[0].path, deep);
    assert.equal(full.instructions, '# Entire instructions');
  });
}

test('files depth is relative to the selected directory', async t => {
  const { loader } = fixture(t, { 'SKILL.md': 'root', 'alpha/root.txt': 'one', 'alpha/deep/leaf.txt': 'two' });
  const shallow = await loader.readNavigation(entry, { view: 'files', path: 'alpha', maxDepth: 0 });
  const deeper = await loader.readNavigation(entry, { view: 'files', path: 'alpha', maxDepth: 1 });
  assert.deepEqual(shallow.files.map(file => file.name), ['deep', 'root.txt']);
  assert.equal(shallow.files[0].children, undefined);
  assert.equal(deeper.files[0].children[0].name, 'leaf.txt');
});

test('navigation rejects escapes, non-directories, missing paths, and invalid options', async t => {
  const { loader, config, directory } = fixture(t, { 'SKILL.md': 'root', 'alpha/SKILL.md': child('alpha') }, false);
  const outside = join(config.skillsDir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(directory, 'escape'));
  for (const path of ['../outside', 'escape', 'alpha/../../outside', '\\bad']) {
    await assert.rejects(loader.readNavigation(entry, { view: 'files', path }), /Path traversal|Invalid path/);
  }
  await assert.rejects(loader.readNavigation(entry, { view: 'files', path: 'SKILL.md' }), /not a directory/);
  await assert.rejects(loader.readNavigation(entry, { view: 'files', path: 'missing' }), /Path not found/);
  await assert.rejects(loader.readNavigation(entry, { view: 'other' }), /Invalid navigation view/);
  await assert.rejects(loader.readNavigation(entry, { view: 'files', maxDepth: -1 }), /maxDepth/);
});

test('remote identity binds source and actual revision, excluding token and file-list order', async t => {
  const { loader, config, marker, save } = fixture(t, { 'SKILL.md': 'root', 'child/SKILL.md': child('child') });
  const first = await loader.readNavigation(entry, { view: 'files' });
  assert.match(first.identity, /^[a-f0-9]{64}$/);
  config.githubToken = 'ANOTHER_SECRET';
  assert.equal((await loader.readNavigation(entry, { view: 'files' })).identity, first.identity);
  marker.files.reverse(); save();
  assert.equal((await loader.readNavigation(entry, { view: 'files' })).identity, first.identity);
  config.githubBranch = 'another-source';
  marker.source.branch = config.githubBranch; save();
  const switched = await loader.readNavigation(entry, { view: 'files' });
  assert.notEqual(switched.identity, first.identity);
  marker.files.find(file => file.path === 'child/SKILL.md').sha = sha('another revision'); save();
  assert.notEqual((await loader.readNavigation(entry, { view: 'files' })).identity, switched.identity);
});

test('requested catalog identity is bound even when a failed refresh serves cached content', async t => {
  const { loader } = fixture(t, { 'SKILL.md': 'root', 'child/SKILL.md': child('child') });
  const before = await loader.readNavigation(entry, { view: 'files' });
  const changed = { ...entry, file_index: { path: '.catalog/' + 'a'.repeat(64) + '.json',
    sha256: 'a'.repeat(64), file_count: 2, total_bytes: 100 } };
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  const stale = await loader.readNavigation(changed, { view: 'files' });
  assert.equal(stale.cache.catalogCurrent, false);
  assert.notEqual(stale.identity, before.identity);
  assert.equal((await loader.readSkill(changed)).navigationIdentity, stale.identity);
});

test('local additions and edited summaries are rescanned for the paging row digest', async t => {
  const { loader, directory } = fixture(t, { 'SKILL.md': 'root', 'child/SKILL.md': child('first') }, false);
  const before = await loader.readNavigation(entry, { view: 'sub_skills' });
  fs.writeFileSync(join(directory, 'child/SKILL.md'), child('other'));
  fs.mkdirSync(join(directory, 'added'));
  fs.writeFileSync(join(directory, 'added/SKILL.md'), child('added'));
  const after = await loader.readNavigation(entry, { view: 'sub_skills' });
  assert.deepEqual(after.sub_skills.map(item => item.name), ['added', 'other']);
  assert.notDeepEqual(after.sub_skills, before.sub_skills);
  assert.equal(after.identity, before.identity, 'the pager binds current rows in addition to source identity');
});

test('a revision changed during summary reads is retried before navigation returns', async t => {
  const { loader, directory, marker, save } = fixture(t, { 'SKILL.md': 'root', 'child/SKILL.md': child('first') });
  const original = fs.promises.readFile;
  let changed = false;
  fs.promises.readFile = async (...args) => {
    const content = await original(...args);
    if (!changed && String(args[0]).endsWith('child/SKILL.md')) {
      changed = true;
      fs.writeFileSync(join(directory, 'child/SKILL.md'), child('other'));
      marker.files.find(file => file.path === 'child/SKILL.md').sha = sha(child('other')); save();
    }
    return content;
  };
  syncBuiltinESMExports();
  try {
    const result = await loader.readNavigation(entry, { view: 'sub_skills' });
    assert.equal(result.sub_skills[0].name, 'other');
    assert.equal(result.identity, (await loader.readSkill(entry)).navigationIdentity);
  } finally { fs.promises.readFile = original; syncBuiltinESMExports(); }
});

test('files-only navigation still repairs missing supporting files before returning', async t => {
  const { loader, directory } = fixture(t, { 'SKILL.md': 'root', 'support.txt': 'support', 'child/SKILL.md': child('child') });
  fs.rmSync(join(directory, 'support.txt'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    assert.ok(String(url).endsWith('/support.txt'));
    return new Response('support');
  });
  rejectRootReads(t, loader);
  const result = await loader.readNavigation(entry, { view: 'files' });
  assert.equal(result.cache.complete, true);
  assert.ok(calls > 0);
  assert.equal(fs.readFileSync(join(directory, 'support.txt'), 'utf8'), 'support');
});

