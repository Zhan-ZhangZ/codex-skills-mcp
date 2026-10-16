/** Smoke-test catalog materialization with a disposable cache and real file downloads.
 * Before source publication: --metadata-dir /path/to/codexproject/codex-skills
 * After publication: omit --metadata-dir to verify the complete remote chain.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseManifest } from '../dist/config.js';
import { fetchManifest, ensureSkillFetched, readSkillCacheState } from '../dist/remote/github.js';

const { values } = parseArgs({ options: {
  'metadata-dir': { type: 'string' },
  skill: { type: 'string', multiple: true },
  repo: { type: 'string', default: 'Zhan-ZhangZ/codexprojec' },
  branch: { type: 'string', default: 'main' },
  path: { type: 'string', default: 'codex-skills' },
} });
const cache = mkdtempSync(join(tmpdir(), 'codex-catalog-smoke-'));
const originalFetch = globalThis.fetch;
const calls = [];
const metadataDir = values['metadata-dir'] ? resolve(values['metadata-dir']) : undefined;
const config = {
  skillsDir: cache, manifestPath: join(cache, 'skills_manifest.json'), isRemote: true,
  githubRepo: values.repo, githubBranch: values.branch, githubPath: values.path,
  githubToken: process.env.GITHUB_TOKEN, useOfficialMirror: true, hedgeEnabled: true,
  downloadConcurrency: 8, downloadTimeout: 15000, manifestTTL: 86400000,
  manifestPollMs: 300000, softDeadlineMs: 55000, hardDeadlineMs: 285000,
};
globalThis.fetch = async (url, options) => {
  const address = new URL(url);
  const path = decodeURIComponent(address.pathname);
  const catalog = path.match(new RegExp('/[.]catalog/([a-f0-9]{64}[.]json)$'));
  const metadataPath = path.endsWith('/skills_manifest.json') ? 'skills_manifest.json'
    : catalog ? `.catalog/${catalog[1]}` : undefined;
  const local = !!(metadataDir && metadataPath);
  calls.push({ host: address.hostname, local });
  if (local) {
    options?.signal?.throwIfAborted();
    return new Response(readFileSync(join(metadataDir, metadataPath)));
  }
  return originalFetch(url, options);
};
try {
  await fetchManifest(config, true);
  const manifest = parseManifest(JSON.parse(readFileSync(config.manifestPath, 'utf8')));
  const indexed = manifest.filter(entry => entry.file_index);
  assert.ok(indexed.length > 0, 'Remote manifest has no file catalogs; publish the source catalogs first.');
  const results = [];
  for (const name of values.skill ?? ['human-writing']) {
    const entry = manifest.find(item => item.name === name);
    assert.ok(entry?.file_index, `No catalog for ${name}`);
    const startCall = calls.length;
    const start = performance.now();
    await ensureSkillFetched(config, entry);
    const coldMs = performance.now() - start;
    const state = readSkillCacheState(config, entry);
    assert.ok(state.complete, `${name} cache incomplete`);
    const catalogBytes = readFileSync(join(cache, entry.file_index.path));
    assert.equal(createHash('sha256').update(catalogBytes).digest('hex'), entry.file_index.sha256);
    const catalog = JSON.parse(catalogBytes);
    let executableFiles = 0;
    for (const file of catalog.files) {
      const local = join(state.localPath, file.path);
      const bytes = readFileSync(local);
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), file.sha);
      if (file.mode === '100755') {
        executableFiles++;
        if (process.platform !== 'win32') assert.equal(statSync(local).mode & 0o111, 0o111);
      }
    }
    const coldCalls = calls.slice(startCall);
    assert.equal(coldCalls.filter(call => call.host === 'api.github.com').length, 0, 'Unexpected GitHub API fallback');
    const beforeWarm = calls.length;
    const warmStart = performance.now();
    await ensureSkillFetched(config, entry);
    const warmMs = performance.now() - warmStart;
    assert.equal(calls.length, beforeWarm, 'Warm cache made a request');
    results.push({ name, files: state.filesTotal, bytes: state.sizeBytes, executableFiles,
      coldMs: +coldMs.toFixed(2), warmMs: +warmMs.toFixed(2),
      networkRequests: coldCalls.filter(call => !call.local).length,
      localMetadataRequests: coldCalls.filter(call => call.local).length });
  }
  console.log(JSON.stringify({ mode: metadataDir ? 'local-metadata-real-remote-files' : 'fully-remote',
    manifestEntries: manifest.length, indexedSkills: indexed.length, results }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  rmSync(cache, { recursive: true, force: true });
}
