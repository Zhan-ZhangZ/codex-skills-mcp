/** Exercise the packed npm artifact and the standalone plugin through stdio. */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Under root so the extracted package resolves the installed production deps.
const staging = mkdtempSync(join(root, '.package-check-'));
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', staging], { cwd: root, encoding: 'utf8' }));
  const files = new Set(result[0].files.map(file => file.path));
  for (const required of [
    'dist/index.js',
    'dist/app.html',
    'dist/lib/http-server.js',
    'package.json',
    'LICENSE',
    'LICENSE.zh-CN.md',
    'NOTICE',
    'CHANGELOG.md',
    'SECURITY.md',
    'docs/INSTALLATION.md',
    'docs/assets/ui-home.png',
    'brand/README.md',
    'brand/logo-white.png',
    'brand/logo-black.png',
    'brand/attribution-snippet.html',
  ]) {
    if (!files.has(required)) throw new Error('Missing package file: ' + required);
  }
  execFileSync('tar', ['-xzf', join(staging, result[0].filename), '-C', staging]);
  for (const entry of [join(staging, 'package/dist/index.js'), join(root, 'plugin/dist/server.js')]) {
    console.log('Checking artifact: ' + entry);
    execFileSync(process.execPath, ['--test', 'test/stdio.test.mjs'], { cwd: root, stdio: 'inherit',
      env: { ...process.env, CODEX_SKILLS_TEST_ENTRY: entry },
    });
  }
  console.log('Package contents and both stdio artifacts passed.');
} finally { rmSync(staging, { recursive: true, force: true }); }
