import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchRemoteManifest } from '../dist/remote/manifest-fetch.js';

const entry = { name: 'demo', description: 'legacy fixture', category: 'test', folder: 'demo', relative_path: './demo' };
const text = JSON.stringify([entry]);
const newer = JSON.stringify([{ ...entry, description: 'updated fixture' }]);
const rawUrl = 'https://raw.githubusercontent.com/owner/repo/main/skills/skills_manifest.json';
const contentsUrl = 'https://api.github.com/repos/owner/repo/contents/skills/skills_manifest.json?ref=main';
const hash = value => createHash('sha256').update(value).digest('hex');
const config = overrides => ({ githubRepo: 'owner/repo', githubBranch: 'main', githubPath: 'skills',
  githubToken: 'TEST_TOKEN', useOfficialMirror: true, hedgeEnabled: true, downloadTimeout: 100, ...overrides });
const options = overrides => ({ authoritativeTimeoutMs: 200, hedgeDelayMs: 10, ...overrides });
const isRaw = url => new URL(url).hostname === 'raw.githubusercontent.com';
const isApi = url => new URL(url).hostname === 'api.github.com';
const validator = (endpoint, body = text, etag = `${endpoint}-etag`) => ({
  url: endpoint === 'raw' ? rawUrl : contentsUrl, bodySha256: hash(body), etag, lastModified: undefined,
});

function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, signal: init.signal });
    return handler(String(url), init);
  });
  return calls;
}

test('valid raw response wins without an API request and returns body-bound validators', async t => {
  const calls = mockFetch(t, async () => new Response(text, { headers: { etag: 'raw-current' } }));
  const result = await fetchRemoteManifest(config(), options());
  assert.equal(result.source, 'raw');
  assert.equal(result.text, text);
  assert.deepEqual(result.entries, [entry]);
  assert.equal(result.notModified, false);
  assert.deepEqual(result.validators.raw, validator('raw', text, 'raw-current'));
  await delay(20);
  assert.equal(calls.length, 1, 'successful reads remove the scheduled API hedge');
});

for (const body of ['invalid JSON', JSON.stringify([{ name: 'missing required fields' }])]) {
  test(`invalid raw manifest advances to a valid Contents API response: ${body}`, async t => {
    const calls = mockFetch(t, async url => new Response(isRaw(url) ? body : text));
    const result = await fetchRemoteManifest(config(), options({ hedgeDelayMs: 100 }));
    assert.equal(result.source, 'contents');
    assert.equal(result.text, text);
    assert.deepEqual(calls.map(call => call.url), [rawUrl, contentsUrl]);
    assert.equal(calls[1].headers.Accept, 'application/vnd.github.raw+json');
    assert.ok(calls.every(call => call.headers.Authorization === 'Bearer TEST_TOKEN'));
  });
}

test('the API hedge succeeds while raw hangs, then aborts raw', async t => {
  const calls = mockFetch(t, async url => isRaw(url) ? new Promise(() => {}) : new Response(text));
  const result = await fetchRemoteManifest(config(), options());
  assert.equal(result.source, 'contents');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, false);
});

test('API failure never interrupts a still-live valid raw request', async t => {
  const calls = mockFetch(t, async url => {
    if (isRaw(url)) { await delay(30); return new Response(text); }
    return new Response('API rate limited', { status: 403 });
  });
  const result = await fetchRemoteManifest(config(), options());
  assert.equal(result.source, 'raw');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, false);
});

test('authority deadline settles even when both transports ignore cancellation', async t => {
  const calls = mockFetch(t, () => new Promise(() => {}));
  await assert.rejects(fetchRemoteManifest(config(), options({
    authoritativeTimeoutMs: 30, allowMirrors: false,
  })), /timed out after 30ms/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.signal.aborted));
});

test('a body stalled after headers stays under the shared deadline and is cancelled', async t => {
  let cancelled = 0;
  const calls = mockFetch(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('[')); },
    cancel() { cancelled++; },
  })));
  await assert.rejects(fetchRemoteManifest(config(), options({
    authoritativeTimeoutMs: 30, allowMirrors: false,
  })), /timed out/);
  await delay(0);
  assert.equal(cancelled, 2);
  assert.ok(calls.every(call => getEventListeners(call.signal, 'abort').length === 0));
});

test('an API winner cancels a raw body without waiting for its stalled stream', async t => {
  let cancelled = false;
  const calls = mockFetch(t, async url => isRaw(url) ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('[')); },
    cancel() { cancelled = true; },
  })) : new Response(text));
  assert.equal((await fetchRemoteManifest(config(), options())).source, 'contents');
  await delay(0);
  assert.equal(cancelled, true);
  assert.ok(calls.every(call => getEventListeners(call.signal, 'abort').length === 0));
});

test('fast invalid mirrors cannot defeat a slower valid legacy manifest or receive credentials', async t => {
  const calls = mockFetch(t, async url => {
    if (isRaw(url) || isApi(url)) return new Response('offline', { status: 503 });
    const host = new URL(url).hostname;
    if (host === 'gh.251716.xyz') return new Response('<html>cached error</html>');
    if (host === 'cdn.jsdelivr.net') return new Response('[{"name":"bad"}]');
    if (host === 'gh-proxy.com') { await delay(5); return new Response(text, { headers: { etag: 'mirror-tag' } }); }
    return new Response('offline', { status: 503 });
  });
  const result = await fetchRemoteManifest(config(), options());
  assert.equal(result.source, 'mirror');
  assert.deepEqual(result.entries, [entry]);
  assert.equal(result.entries[0].file_index, undefined, 'legacy custom manifests need no catalog');
  assert.deepEqual(result.validators, {}, 'a mirror ETag must never become an official validator');
  for (const call of calls) {
    const official = isRaw(call.url) || isApi(call.url);
    assert.equal(call.headers.Authorization, official ? 'Bearer TEST_TOKEN' : undefined);
    if (!official) assert.equal(call.headers['If-None-Match'], undefined);
  }
});

test('a valid same-source cache is protected even if an old mirror would be valid', async t => {
  const indexed = JSON.stringify([{ ...entry, file_index: { path: `.catalog/${'a'.repeat(64)}.json`,
    sha256: 'a'.repeat(64), file_count: 1, total_bytes: 10 } }]);
  const snapshot = { text: indexed, validators: { raw: validator('raw', indexed) } };
  const before = JSON.stringify(snapshot);
  const calls = mockFetch(t, async url => isRaw(url) || isApi(url)
    ? new Response('offline', { status: 503 }) : new Response(text));
  await assert.rejects(fetchRemoteManifest(config(), options({ cached: snapshot })), /All download nodes failed/);
  assert.equal(calls.length, 2, 'no public mirror may overwrite a valid cache after authority failure');
  assert.equal(JSON.stringify(snapshot), before);
});

test('cache protection also covers legacy manifests without catalogs', async t => {
  const calls = mockFetch(t, async () => new Response('offline', { status: 503 }));
  await assert.rejects(fetchRemoteManifest(config(), options({ cached: { text } })), /All download nodes failed/);
  assert.equal(calls.length, 2);
});

test('an authoritative response may intentionally remove catalog metadata', async t => {
  const indexed = JSON.stringify([{ ...entry, file_index: { path: `.catalog/${'a'.repeat(64)}.json`,
    sha256: 'a'.repeat(64), file_count: 1, total_bytes: 10 } }]);
  mockFetch(t, async () => new Response(text));
  const result = await fetchRemoteManifest(config(), options({ cached: { text: indexed } }));
  assert.equal(result.text, text, 'do not invent a version ordering from catalog presence or entry counts');
});

test('corrupt cache validators are discarded and legacy mirror bootstrap remains available', async t => {
  const calls = mockFetch(t, async url => isRaw(url) || isApi(url)
    ? new Response('offline', { status: 503 }) : new Response(text));
  const result = await fetchRemoteManifest(config(), options({
    cached: { text: 'broken', validators: { raw: validator('raw', 'broken') } },
  }));
  assert.equal(result.source, 'mirror');
  assert.ok(calls.every(call => call.headers['If-None-Match'] === undefined));
});

test('allowMirrors false prevents fallback for a fresh source', async t => {
  const calls = mockFetch(t, async () => new Response('offline', { status: 503 }));
  await assert.rejects(fetchRemoteManifest(config(), options({ allowMirrors: false })), /All download nodes failed/);
  assert.equal(calls.length, 2);
});

test('raw 304 reuses only the validated cached body and refreshes raw headers', async t => {
  const calls = mockFetch(t, async () => new Response(null, { status: 304, headers: { etag: 'raw-refreshed' } }));
  const result = await fetchRemoteManifest(config(), options({ cached: { text, validators: {
    raw: validator('raw'), contents: validator('contents'),
  } } }));
  assert.equal(result.text, text);
  assert.equal(result.notModified, true);
  assert.equal(result.source, 'raw');
  assert.equal(calls[0].headers['If-None-Match'], 'raw-etag');
  assert.equal(result.validators.raw.etag, 'raw-refreshed');
  assert.equal(result.validators.contents.etag, 'contents-etag');
});

test('API validators never travel to raw, and an API 304 uses the matching body', async t => {
  const calls = mockFetch(t, async url => isRaw(url)
    ? new Response('offline', { status: 503 }) : new Response(null, { status: 304 }));
  const result = await fetchRemoteManifest(config(), options({ cached: { text, validators: { contents: validator('contents') } } }));
  assert.equal(result.source, 'contents');
  assert.equal(result.notModified, true);
  assert.equal(calls[0].headers['If-None-Match'], undefined);
  assert.equal(calls[1].headers['If-None-Match'], 'contents-etag');
});

for (const wrong of [
  { bodySha256: hash('old bytes') },
  { url: 'https://raw.githubusercontent.com/other/repo/main/skills/skills_manifest.json' },
  { url: contentsUrl },
]) {
  test(`mismatched validator cannot authorize raw 304: ${JSON.stringify(wrong)}`, async t => {
    const calls = mockFetch(t, async url => isRaw(url)
      ? new Response(null, { status: 304 }) : new Response(newer));
    const result = await fetchRemoteManifest(config(), options({ cached: { text, validators: { raw: { ...validator('raw'), ...wrong } } } }));
    assert.equal(result.source, 'contents');
    assert.equal(result.text, newer);
    assert.equal(result.notModified, false);
    assert.equal(calls[0].headers['If-None-Match'], undefined);
  });
}

test('unsolicited 304 responses never bootstrap an absent cache', async t => {
  mockFetch(t, async () => new Response(null, { status: 304 }));
  await assert.rejects(fetchRemoteManifest(config(), options({ allowMirrors: false })), /Unexpected 304/);
});

test('Last-Modified is endpoint-specific and subordinate to ETag', async t => {
  const calls = mockFetch(t, async url => isRaw(url)
    ? new Response('offline', { status: 503 }) : new Response(null, { status: 304 }));
  const raw = { ...validator('raw'), lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' };
  const contents = { ...validator('contents'), etag: undefined, lastModified: 'Tue, 02 Jan 2024 00:00:00 GMT' };
  await fetchRemoteManifest(config(), options({ cached: { text, validators: { raw, contents } } }));
  assert.equal(calls[0].headers['If-None-Match'], 'raw-etag');
  assert.equal(calls[0].headers['If-Modified-Since'], undefined);
  assert.equal(calls[1].headers['If-Modified-Since'], contents.lastModified);
});

test('changed content drops old validators for every other endpoint', async t => {
  mockFetch(t, async () => new Response(newer, { headers: { etag: 'new-raw' } }));
  const result = await fetchRemoteManifest(config(), options({ cached: { text, validators: { raw: validator('raw'), contents: validator('contents') } } }));
  assert.deepEqual(result.validators, { raw: validator('raw', newer, 'new-raw') });
});

test('an identical 200 without validators removes stale headers only for that endpoint', async t => {
  mockFetch(t, async () => new Response(text));
  const result = await fetchRemoteManifest(config(), options({ cached: { text, validators: { raw: validator('raw'), contents: validator('contents') } } }));
  assert.deepEqual(result.validators, { contents: validator('contents') });
  assert.equal(result.notModified, false);
});

test('repository, manifest path and branch are encoded for both official endpoints', async t => {
  const calls = mockFetch(t, async url => isRaw(url) ? new Response('', { status: 503 }) : new Response(text));
  await fetchRemoteManifest(config({ githubRepo: 'owner name/repo#name', githubBranch: 'feature/a b#1', githubPath: './skills space/中文' }), options());
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/owner%20name/repo%23name/feature%2Fa%20b%231/skills%20space/%E4%B8%AD%E6%96%87/skills_manifest.json');
  assert.equal(calls[1].url, 'https://api.github.com/repos/owner%20name/repo%23name/contents/skills%20space/%E4%B8%AD%E6%96%87/skills_manifest.json?ref=feature%2Fa%20b%231');
});

test('oversized or malformed UTF-8 responses cannot win over a valid endpoint', async t => {
  let round = 0;
  mockFetch(t, async url => {
    if (!isRaw(url)) return new Response(text);
    return round++ === 0 ? new Response(text, { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } })
      : new Response(new Uint8Array([0xc0, 0xaf]));
  });
  assert.equal((await fetchRemoteManifest(config(), options())).source, 'contents');
  assert.equal((await fetchRemoteManifest(config(), options())).source, 'contents');
});

test('streaming body limits apply even without Content-Length and cancel the rejected reader', async t => {
  let cancelled = 0;
  mockFetch(t, async url => {
    if (!isRaw(url)) return new Response(text);
    // Reuse one chunk: test the streamed byte counter without allocating a
    // complete oversized manifest in the test process.
    const chunk = new Uint8Array(8 * 1024 * 1024);
    return new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < 9; i++) controller.enqueue(chunk); },
      cancel() { cancelled++; },
    }));
  });
  assert.equal((await fetchRemoteManifest(config(), options())).source, 'contents');
  assert.equal(cancelled, 1);
});

test('UTF-8 BOM manifests keep the previous Response.text compatibility', async t => {
  mockFetch(t, async () => new Response(`\uFEFF${text}`));
  assert.equal((await fetchRemoteManifest(config(), options())).text, text);
});

test('fresh-source mirror bodies have their own bounded shared deadline', async t => {
  const calls = mockFetch(t, async url => isRaw(url) || isApi(url)
    ? new Response('offline', { status: 503 }) : new Promise(() => {}));
  await assert.rejects(fetchRemoteManifest(config({ downloadTimeout: 20 }), options()), /Mirror fallback: Manifest fetch timed out after 20ms/);
  const mirrors = calls.filter(call => !isRaw(call.url) && !isApi(call.url));
  assert.equal(mirrors.length, 4);
  assert.ok(mirrors.every(call => call.signal.aborted));
});

test('late fetch responses that ignored cancellation have their bodies cancelled', async t => {
  let release;
  let cancelled = 0;
  const late = new Promise(resolve => { release = resolve; });
  mockFetch(t, async url => {
    if (!isRaw(url)) return new Response(text);
    await late;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }));
  });
  assert.equal((await fetchRemoteManifest(config(), options())).source, 'contents');
  release();
  await delay(0);
  assert.equal(cancelled, 1);
});

test('invalid budgets fail before making requests', async t => {
  const calls = mockFetch(t, () => assert.fail('should not fetch'));
  for (const authoritativeTimeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(fetchRemoteManifest(config(), options({ authoritativeTimeoutMs })), /timeout/);
  }
  await assert.rejects(fetchRemoteManifest(config(), options({ hedgeDelayMs: -1 })), /hedge delay/);
  assert.equal(calls.length, 0);
});
