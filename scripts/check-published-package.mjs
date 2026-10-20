/** Validate an exact npm release with fresh production dependencies and remote catalogs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version || !/^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/check-published-package.mjs <exact-version>');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staging = mkdtempSync(join(tmpdir(), 'codex-published-check-'));
try {
  execFileSync('npm', ['install', '--prefix', staging, '--package-lock=false', '--ignore-scripts',
    '--no-audit', '--no-fund', '--prefer-online', '--cache', join(staging, 'npm-cache'),
    '--registry=https://registry.npmjs.org', `codex-skills-mcp@${version}`],
  { cwd: staging, stdio: 'inherit' });
  const installed = join(staging, 'node_modules', 'codex-skills-mcp');
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, version);
  execFileSync(process.execPath, ['--test', 'test/stdio.test.mjs'], { cwd: root, stdio: 'inherit',
    env: { ...process.env, CODEX_SKILLS_TEST_ENTRY: join(installed, 'dist/index.js') },
  });
  // The unchanged smoke helper now imports the installed release's dist,
  // so the network check exercises npm content rather than this checkout.
  const scripts = join(installed, 'scripts');
  mkdirSync(scripts, { recursive: true });
  const smoke = join(scripts, 'check-remote-catalog.mjs');
  copyFileSync(join(root, 'scripts/check-remote-catalog.mjs'), smoke);
  execFileSync(process.execPath, [smoke, '--skill', 'human-writing'], { cwd: staging, stdio: 'inherit' });
  console.log(`Published codex-skills-mcp@${version}: isolated install, stdio and remote catalog checks passed.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
