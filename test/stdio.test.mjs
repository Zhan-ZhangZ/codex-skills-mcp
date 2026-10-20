import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entrypoint = process.env.CODEX_SKILLS_TEST_ENTRY ?? resolve('dist/index.js');

test('CLI help/version need no library, settings or network', () => {
  assert.match(execFileSync(process.execPath, [entrypoint, '--version'], { encoding: 'utf8' }), /^\d+\.\d+\.\d+/);
  assert.match(execFileSync(process.execPath, [entrypoint, '--help'], { encoding: 'utf8' }), /--skills-dir/);
});

test('built stdio server completes the entire local skill workflow', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'skills-stdio-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'engineering', 'sample'), { recursive: true });
  writeFileSync(join(directory, 'engineering', 'sample', 'SKILL.md'), '# Sample instructions\nRun the supplied validation.');
  writeFileSync(join(directory, 'engineering', 'sample', 'README.md'), 'Supporting text');
  writeFileSync(join(directory, 'engineering', 'sample', 'large.md'), '研究数据😀\n'.repeat(50_000));
  writeFileSync(join(directory, 'skills_manifest.json'), JSON.stringify([{ name: 'sample', description: 'TypeScript code testing 测试', category: 'engineering', folder: 'sample', relative_path: './engineering/sample' }]));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [entrypoint, '--skills-dir', directory], stderr: 'pipe',
    env: { ...process.env, CODEX_SKILLS_SETTINGS_DIR: join(directory, 'settings'),
      CODEX_SKILLS_TOOL_PROFILE: 'full' },
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'workflow-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.match(client.getInstructions(), /MATERIALIZE/);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 22);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.match(text(await call('search_skills', { query: 'TypeScript testing' })), /sample/);
  assert.match(text(await call('list_categories')), /engineering/);
  assert.match(text(await call('plan_workflow', { task_description: 'TypeScript testing' })), /sample/);
  const read = await call('read_skill', { name: 'sample' });
  assert.ok(!read.isError);
  assert.match(text(read), /Sample instructions/);
  assert.match(text(read), /local_path/);
  assert.match(text(await call('load_skill_file', { skill_name: 'sample', file_path: 'README.md' })), /Supporting text/);
  const large = await call('load_skill_file', { skill_name: 'sample', file_path: 'large.md', max_bytes: 1024 });
  assert.equal(large.structuredContent.has_more, true);
  assert.equal(large.structuredContent.offset, 0);
  assert.ok(large.structuredContent.next_offset > 0);
  assert.match(text(large), /More content: load_skill_file/);
  assert.match(text(await call('list_skill_files', { skill_name: 'sample' })), /SKILL.md/);
  assert.match(text(await call('skill_status', { names: 'sample' })), /1\/1 complete/);
  assert.match(text(await call('diagnostics', { include_log: false })), /local/);
  assert.match(text(await call('diagnostics', { include_log: false })), /HTTP admission/);
  assert.equal((await call('read_skill', { name: 'missing' })).isError, true);
  assert.equal((await call('load_skill_file', { skill_name: 'sample', file_path: '../escape' })).isError, true);
  assert.equal((await call('list_skill_files', { skill_name: 'sample', max_depth: 999 })).isError, true);
  assert.match((await client.readResource({ uri: 'skill://sample' })).contents[0].text, /Sample instructions/);
  assert.ok((await client.readResource({ uri: 'ui://codex-skills/app' })).contents[0].text.includes('ui/initialize'));
  assert.ok(!/Fatal error/.test(stderr), stderr);
});

test('auto tool profile exposes only core tools to Codex while keeping skill resources', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'skills-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'engineering', 'sample'), { recursive: true });
  writeFileSync(join(directory, 'engineering', 'sample', 'SKILL.md'), '# Sample instructions');
  writeFileSync(join(directory, 'skills_manifest.json'), JSON.stringify([
    { name: 'sample', description: 'TypeScript code testing', category: 'engineering', folder: 'sample', relative_path: './engineering/sample' },
  ]));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [entrypoint, '--skills-dir', directory], stderr: 'ignore',
    env: { ...process.env, CODEX_SKILLS_SETTINGS_DIR: join(directory, 'settings') },
  });
  const client = new Client({ name: 'codex', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), [
    'diagnostics', 'list_categories', 'list_skill_files', 'load_skill_file',
    'plan_workflow', 'read_skill', 'search_skills', 'skill_status',
  ]);
  assert.ok(!names.includes('settings.read'));
  assert.ok(!names.includes('skills.clearCache'));
  assert.equal((await client.callTool({ name: 'settings.read', arguments: {} })).isError, true);
  assert.match((await client.readResource({ uri: 'skill://sample' })).contents[0].text, /Sample instructions/);
});

test('auto tool profile keeps the full surface for MCP Apps clients', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'skills-profile-full-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'engineering', 'sample'), { recursive: true });
  writeFileSync(join(directory, 'engineering', 'sample', 'SKILL.md'), '# Sample instructions');
  writeFileSync(join(directory, 'skills_manifest.json'), JSON.stringify([
    { name: 'sample', description: 'TypeScript code testing', category: 'engineering', folder: 'sample', relative_path: './engineering/sample' },
  ]));
  for (const name of ['ChatGPT', 'codex-mcp-client', 'Codex Desktop']) {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [entrypoint, '--skills-dir', directory], stderr: 'ignore',
      env: { ...process.env, CODEX_SKILLS_SETTINGS_DIR: join(directory, `settings-${name}`) },
    });
    const client = new Client({ name, version: '1' });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 22, name);
    await client.close();
  }
});
