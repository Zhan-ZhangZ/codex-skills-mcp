import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DownloadHedger } from '../dist/remote/hedging.js';
import { ensureSkillFetched } from '../dist/remote/github.js';

// Deterministic clock: scheduling assertions do not depend on wall-clock tolerances.
class Clock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = id => { this.timers.delete(id); };
  async tick(ms) {
    const until = this.time + ms;
    await flush();
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > until) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = until;
    await flush();
  }
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const nodes = ['primary', 'raw', 'cdn', 'proxy', 'last'].map(name => ({ name }));
const options = (overrides = {}) => ({ nodes, key: 'source', path: 'SKILL.md', enabled: true, verified: true, timeoutMs: 30000, ...overrides });

function transport(clock, outcomes = {}) {
  const calls = [];
  const attempt = (node, signal, remainingMs) => {
    const call = { name: node.name, at: clock.now(), remainingMs, signal, aborted: false };
    calls.push(call);
    const outcome = outcomes[node.name] ?? { ms: Infinity };
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (timer !== undefined) clock.clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => { call.aborted = true; cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(outcome.ms)) timer = clock.setTimeout(() => {
        cleanup();
        if (outcome.error) reject(new Error(outcome.error));
        else resolve(node.name);
      }, outcome.ms);
    });
  };
  return { attempt, calls };
}

async function prime(hedger, key, winner = 'raw', overrides = {}) {
  return hedger.run(options({ key, ...overrides }), async node => {
    if (node.name !== winner) throw new Error('route unavailable');
    return node.name;
  });
}

test('fast cold primary completes with one attempt and removes every timer', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const io = transport(clock, { primary: { ms: 150 } });
  const pending = hedger.run(options(), io.attempt);
  await clock.tick(150);
  assert.equal((await pending).value, 'primary');
  assert.equal(io.calls.length, 1);
  assert.equal(clock.timers.size, 0);
  await clock.tick(30000);
  assert.equal(io.calls.length, 1);
});

test('cold fallback matches the original 400ms all-node schedule', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const io = transport(clock, { last: { ms: 70 } });
  const pending = hedger.run(options(), io.attempt);
  await clock.tick(470);
  assert.equal((await pending).value, 'last');
  assert.deepEqual(io.calls.map(c => [c.name, c.at]), nodes.map((n, i) => [n.name, i ? 400 : 0]));
  assert.equal(io.calls.filter(c => c.aborted).length, 4);
  assert.equal(clock.timers.size, 0);
});

test('a remembered winner starts alongside the cold primary and cancels remaining hedges', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'source');
  const io = transport(clock, { raw: { ms: 70 } });
  const pending = hedger.run(options(), io.attempt);
  await clock.tick(70);
  assert.equal((await pending).value, 'raw');
  assert.deepEqual(io.calls.map(c => [c.name, c.at]), [['primary', 0], ['raw', 0]]);
  assert.equal(io.calls[0].aborted, true);
  const next = hedger.run(options(), io.attempt);
  await clock.tick(70);
  await next;
  assert.equal(io.calls.length, 4, 'loser cancellation must not erase the learned winner');
  assert.equal(clock.timers.size, 0);
});

test('a remembered slow route cannot delay any original node', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'source', 'last');
  const io = transport(clock, { cdn: { ms: 70 } });
  const pending = hedger.run(options(), io.attempt);
  await clock.tick(470);
  assert.equal((await pending).value, 'cdn');
  assert.deepEqual(io.calls.map(c => [c.name, c.at]), [['primary', 0], ['last', 0], ['raw', 400], ['cdn', 400], ['proxy', 400]]);
  assert.equal(clock.timers.size, 0);
});

test('a remembered cold primary is not launched twice', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'source', 'primary');
  const io = transport(clock, { primary: { ms: 50 } });
  const pending = hedger.run(options(), io.attempt);
  await clock.tick(50);
  await pending;
  assert.equal(io.calls.length, 1);
  assert.equal(clock.timers.size, 0);
});

test('explicit failure immediately launches every remaining fallback', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const io = transport(clock, { primary: { ms: 20, error: 'HTTP 503' }, last: { ms: 50 } });
  const pending = hedger.run(options(), io.attempt);
  await clock.tick(70);
  assert.equal((await pending).value, 'last');
  assert.deepEqual(io.calls.map(c => c.at), [0, 20, 20, 20, 20]);
  assert.equal(clock.timers.size, 0);
});

test('all failures finish early with each error and no leftover timers', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const io = transport(clock, Object.fromEntries(nodes.map(n => [n.name, { ms: 20, error: `bad ${n.name}` }])));
  const pending = assert.rejects(hedger.run(options(), io.attempt), error => {
    for (const node of nodes) assert.ok(error.message.includes(`[${node.name}] bad ${node.name}`));
    return true;
  });
  await clock.tick(40);
  await pending;
  assert.deepEqual(io.calls.map(c => c.at), [0, 20, 20, 20, 20]);
  assert.equal(clock.timers.size, 0);
});

test('no-hedge races all nodes immediately and does not change route preferences', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'source', 'last');
  const io = transport(clock, { primary: { ms: 20 } });
  const pending = hedger.run(options({ enabled: false }), io.attempt);
  await clock.tick(20);
  await pending;
  assert.deepEqual(io.calls.map(c => [c.name, c.at]), nodes.map(n => [n.name, 0]));
  const starts = [];
  await hedger.run(options(), async node => { starts.push(node.name); return node.name; });
  assert.deepEqual(starts, ['primary', 'last']);
  assert.equal(clock.timers.size, 0);
});

test('unverified downloads neither learn nor consume remembered preferences', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'source', 'last', { verified: false });
  const starts = [];
  await hedger.run(options(), async node => { starts.push(node.name); return node.name; });
  assert.deepEqual(starts, ['primary']);
  await prime(hedger, 'source', 'last');
  starts.length = 0;
  await hedger.run(options({ verified: false }), async node => { starts.push(node.name); return node.name; });
  assert.deepEqual(starts, ['primary']);
});

test('winner memory is isolated by source, expires, and evicts beyond 32 sources', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'known');
  const probe = async key => {
    const starts = [];
    await hedger.run(options({ key }), async node => { starts.push(node.name); return node.name; });
    return starts;
  };
  assert.deepEqual(await probe('unrelated'), ['primary']);
  assert.deepEqual(await probe('known'), ['primary', 'raw']);
  await clock.tick(5 * 60 * 1000);
  assert.deepEqual(await probe('known'), ['primary']);
  for (let i = 0; i < 33; i++) await prime(hedger, `bounded-${i}`);
  assert.deepEqual(await probe('bounded-32'), ['primary', 'raw']);
  assert.deepEqual(await probe('bounded-0'), ['primary']);
  assert.equal(clock.timers.size, 0);
});

test('slow successful bodies cannot inflate the fallback deadline of later requests', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  for (let i = 0; i < 3; i++) {
    const io = transport(clock, { primary: { ms: 10000 } });
    const pending = hedger.run(options(), io.attempt);
    await clock.tick(10000);
    await pending;
    assert.equal(io.calls.length, 5);
    assert.equal(io.calls[4].at - io.calls[0].at, 400);
  }
  assert.equal(clock.timers.size, 0);
});

test('one deadline covers delayed attempts and aborts every hanging operation', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const io = transport(clock);
  const pending = assert.rejects(hedger.run(options({ timeoutMs: 2000 }), io.attempt), /timed out after 2000ms/);
  await clock.tick(2000);
  await pending;
  assert.deepEqual(io.calls.map(c => c.remainingMs), [2000, 1600, 1600, 1600, 1600]);
  assert.ok(io.calls.every(c => c.aborted));
  assert.equal(clock.timers.size, 0);
});

test('short budgets still launch every fallback before the common deadline', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const io = transport(clock);
  const pending = assert.rejects(hedger.run(options({ timeoutMs: 20 }), io.attempt), /timed out/);
  await clock.tick(20);
  await pending;
  assert.deepEqual(io.calls.map(c => c.at), [0, 5, 5, 5, 5]);
  assert.ok(io.calls.every(c => c.aborted));
  assert.equal(clock.timers.size, 0);
});

test('deadline settles even if a transport ignores its abort signal', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const signals = [];
  const pending = assert.rejects(hedger.run(options({ timeoutMs: 20 }), (_node, signal) => {
    signals.push(signal);
    return new Promise(() => {});
  }), /timed out/);
  await clock.tick(20);
  await pending;
  assert.equal(signals.length, 5);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(clock.timers.size, 0);
});

test('synchronous transport errors use the normal fallback and cleanup path', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const result = await hedger.run(options(), node => {
    if (node.name === 'primary') throw new Error('synchronous failure');
    return Promise.resolve(node.name);
  });
  assert.equal(result.value, 'raw');
  assert.equal(clock.timers.size, 0);
});

test('a late concurrent failure cannot delete a newly validated winner', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'source');
  const oldIo = transport(clock, { raw: { ms: 50, error: 'old request failed' } });
  const old = assert.rejects(hedger.run(options({ timeoutMs: 100 }), oldIo.attempt), /timed out/);
  const newIo = transport(clock, { raw: { ms: 10 } });
  const current = hedger.run(options(), newIo.attempt);
  await clock.tick(10);
  assert.equal((await current).value, 'raw');
  await clock.tick(90);
  await old;
  const starts = [];
  await hedger.run(options(), async node => { starts.push(node.name); return node.name; });
  assert.deepEqual(starts, ['primary', 'raw'], 'late failure/deadline must preserve the newer route identity');
  assert.equal(clock.timers.size, 0);
});

test('an older slow winner cannot overwrite a route established by a newer concurrent request', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  const slowIo = transport(clock, { primary: { ms: 1300 } });
  const old = hedger.run(options(), slowIo.attempt);
  await clock.tick(100);
  const fastIo = transport(clock, { raw: { ms: 100 } });
  const current = hedger.run(options(), fastIo.attempt);
  await clock.tick(500);
  assert.equal((await current).value, 'raw');
  await clock.tick(700);
  assert.equal((await old).value, 'primary');
  const starts = [];
  await hedger.run(options(), async node => { starts.push(node.name); return node.name; });
  assert.deepEqual(starts, ['primary', 'raw']);
  assert.equal(clock.timers.size, 0);
});

test('a real preferred-route failure removes its obsolete preference', async () => {
  const clock = new Clock();
  const hedger = new DownloadHedger(clock);
  await prime(hedger, 'source');
  await assert.rejects(hedger.run(options(), async () => { throw new Error('route gone'); }), /All download nodes failed/);
  const starts = [];
  await hedger.run(options(), async node => { starts.push(node.name); return node.name; });
  assert.deepEqual(starts, ['primary']);
  assert.equal(clock.timers.size, 0);
});

function cachedMissing(t, overrides = {}, bytes = 'good') {
  const root = mkdtempSync(join(tmpdir(), 'codex-hedging-test-'));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
  const config = { skillsDir: root, manifestPath: join(root, 'manifest.json'), isRemote: true,
    githubRepo: 'fixture/repo', githubBranch: 'main', githubPath: 'skills', githubToken: 'TEST_TOKEN',
    useOfficialMirror: true, hedgeEnabled: true, downloadConcurrency: 1, downloadTimeout: 1000, manifestTTL: 0, ...overrides };
  const entry = { name: 'demo', description: 'fixture', category: 'test', folder: 'demo', relative_path: 'demo' };
  const sha = createHash('sha1').update(`blob ${bytes.length}`).update(Buffer.from([0])).update(bytes).digest('hex');
  const dir = join(root, 'demo');
  mkdirSync(dir);
  writeFileSync(join(dir, '.codex-skills.tree.json'), JSON.stringify({ version: 1, completedAt: new Date().toISOString(),
    source: { repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath },
    files: ['SKILL.md', 'README.md'].map(path => ({ path, size: bytes.length, sha })),
  }));
  return { config, entry, dir };
}

test('integration: SHA-rejected content never wins or learns, while verified raw is reused', async t => {
  const { config, entry, dir } = cachedMissing(t);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const host = new URL(url).hostname;
    calls.push({ host, authorization: options.headers.Authorization });
    if (host === 'gh.251716.xyz' && new URL(url).pathname.endsWith('/README.md')) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    return new Response(host === 'raw.githubusercontent.com' ? 'good' : 'evil');
  };
  await ensureSkillFetched(config, entry);
  assert.deepEqual(calls.map(c => c.host), ['gh.251716.xyz', 'raw.githubusercontent.com', 'cdn.jsdelivr.net',
    'gh-proxy.com', 'ghfast.top', 'gh.251716.xyz', 'raw.githubusercontent.com']);
  for (const call of calls) assert.equal(call.authorization, call.host === 'raw.githubusercontent.com' ? 'Bearer TEST_TOKEN' : undefined);
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), 'good');
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'good');
});

test('integration: disabling the official mirror preserves the original immediate four-node race', async t => {
  const { config, entry } = cachedMissing(t, { useOfficialMirror: false });
  const calls = [];
  globalThis.fetch = async url => { calls.push(new URL(url).hostname); return new Response('good'); };
  await ensureSkillFetched(config, entry);
  assert.deepEqual(calls, Array(2).fill(['raw.githubusercontent.com', 'cdn.jsdelivr.net', 'gh-proxy.com', 'ghfast.top']).flat());
});

test('integration: no-hedge races all enabled nodes without sending credentials to mirrors', async t => {
  const { config, entry } = cachedMissing(t, { hedgeEnabled: false });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const host = new URL(url).hostname;
    calls.push(host);
    assert.equal(options.headers.Authorization, host === 'raw.githubusercontent.com' ? 'Bearer TEST_TOKEN' : undefined);
    return new Response('good');
  };
  await ensureSkillFetched(config, entry);
  assert.equal(calls.length, 10);
  for (const host of ['gh.251716.xyz', 'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'gh-proxy.com', 'ghfast.top']) {
    assert.equal(calls.filter(h => h === host).length, 2);
  }
});

test('integration: a bodyless response can materialize a correctly hashed zero-byte file', async t => {
  const { config, entry, dir } = cachedMissing(t, {}, '');
  const calls = [];
  globalThis.fetch = async url => { calls.push(new URL(url).hostname); return new Response(null, { status: 204 }); };
  await ensureSkillFetched(config, entry);
  assert.deepEqual(calls, ['gh.251716.xyz', 'gh.251716.xyz']);
  assert.equal(readFileSync(join(dir, 'SKILL.md')).length, 0);
  assert.equal(readFileSync(join(dir, 'README.md')).length, 0);
});

test('integration: a bodyless success with the wrong empty-blob SHA is rejected', async t => {
  const { config, entry, dir } = cachedMissing(t, {}, '');
  const markerPath = join(dir, '.codex-skills.tree.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  for (const file of marker.files) file.sha = '0'.repeat(40);
  writeFileSync(markerPath, JSON.stringify(marker));
  const calls = [];
  globalThis.fetch = async url => { calls.push(new URL(url).hostname); return new Response(null, { status: 204 }); };
  await assert.rejects(ensureSkillFetched(config, entry), /Git blob SHA mismatch/);
  assert.equal(calls.length, 10, 'bad empty responses must fail every candidate, never learn a winner');
  assert.throws(() => readFileSync(join(dir, 'SKILL.md')), { code: 'ENOENT' });
});
