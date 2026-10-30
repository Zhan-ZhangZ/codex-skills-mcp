import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const pluginRoot = join(root, 'plugin');
const pluginPackage = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

test('marketplace plugin starts through the bundled runtime launcher without PATH node', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'skills-plugin-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const skillsDir = join(directory, 'skills');
  const skillDir = join(skillsDir, 'engineering', 'plugin-smoke');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Plugin smoke skill\n\nUse the bundled launcher.');
  writeFileSync(join(skillsDir, 'skills_manifest.json'), JSON.stringify([
    {
      name: 'plugin-smoke',
      description: 'Verify plugin runtime startup',
      category: 'engineering',
      folder: 'plugin-smoke',
      relative_path: './engineering/plugin-smoke',
    },
  ]));

  const launcher = join(
    pluginRoot,
    'scripts',
    process.platform === 'win32'
      ? 'launch-codex-skills-mcp.cmd'
      : 'launch-codex-skills-mcp',
  );
  const server = join(pluginRoot, 'dist', 'server.js');
  const transport = new StdioClientTransport({
    command: launcher,
    args: [server, '--skills-dir', skillsDir],
    cwd: pluginRoot,
    stderr: 'pipe',
    env: {
      CODEX_MCP_NODE_PATH: process.execPath,
      CODEX_SKILLS_DIR: skillsDir,
      CODEX_SKILLS_SETTINGS_DIR: join(directory, 'settings'),
      CODEX_SKILLS_TOOL_PROFILE: 'full',
      HOME: directory,
      USERPROFILE: directory,
      LOCALAPPDATA: join(directory, 'localappdata'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      PATH: process.platform === 'win32'
        ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
        : '/usr/bin:/bin',
    },
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });

  const client = new Client({ name: 'plugin-runtime-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);

  assert.equal(client.getServerVersion()?.version, pluginPackage.version);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes('search_skills'));
  assert.ok(tools.includes('read_skill'));
  const search = await client.callTool({
    name: 'search_skills',
    arguments: { query: 'plugin runtime startup' },
  });
  assert.match(
    search.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n'),
    /plugin-smoke/,
  );
  assert.match(stderr, /Server running on stdio/);
});
