import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";

// No real user settings, cache, credentials or network are touched.
const directory = mkdtempSync(join(tmpdir(), "codex-skills-extensions-"));
const previousSettingsDirectory = process.env.CODEX_SKILLS_SETTINGS_DIR;
process.env.CODEX_SKILLS_SETTINGS_DIR = directory;
const { applyPersistedSettingsAtStartup, registerOpenAISettings } = await import("../dist/openai/settings.js");
const { registerOpenAIMentions } = await import("../dist/openai/mentions.js");
const { SkillSearchEngine } = await import("../dist/search/index.js");
const settingsPath = join(directory, "settings.json");

after(() => {
  if (previousSettingsDirectory === undefined) delete process.env.CODEX_SKILLS_SETTINGS_DIR;
  else process.env.CODEX_SKILLS_SETTINGS_DIR = previousSettingsDirectory;
  rmSync(directory, { recursive: true, force: true });
});

function config(overrides = {}) {
  return {
    skillsDir: directory, manifestPath: join(directory, "skills_manifest.json"),
    isRemote: false, githubPath: "skills", useOfficialMirror: false, hedgeEnabled: false,
    softDeadlineMs: 200, hardDeadlineMs: 500, downloadConcurrency: 16,
    downloadTimeout: 30000, manifestTTL: 86400000, manifestPollMs: 300000,
    ...overrides,
  };
}

const names = ["Scientific Agent Skills", "中文技能", "hash#name", "slash/name", "literal%2Fname"];
const manifest = names.map((name, index) => ({
  name, description: `Fixture skill ${index}`, category: "test", folder: `skill-${index}`,
  relative_path: `./skill-${index}`,
}));

async function session(t, register) {
  const server = new McpServer({ name: "extension-test", version: "1.0.0" });
  const client = new Client({ name: "extension-test-client", version: "1.0.0" });
  register(server, new OpenAIExtensions(server));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

function settingsSession(t, sharedConfig) {
  return session(t, (server, extensions) => registerOpenAISettings(
    server, extensions, sharedConfig, new SkillSearchEngine(manifest)
  ));
}

const readSettings = async (client) => {
  const result = await client.callTool({ name: "settings.read", arguments: {} });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent.values;
};

const updateSettings = async (client, set) => {
  const result = await client.callTool({ name: "settings.update", arguments: { set } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent.values;
};

test("settings reflect CLI precedence and preserve a seconds-based TTL", async (t) => {
  writeFileSync(settingsPath, JSON.stringify({ download_concurrency: 8, manifest_ttl_hours: 24 }));
  const shared = config({ downloadConcurrency: 3, manifestTTL: 90000,
    explicitCli: new Set(["download_concurrency", "manifest_ttl_hours"]) });
  applyPersistedSettingsAtStartup(shared);
  const client = await settingsSession(t, shared);
  const values = await readSettings(client);
  assert.equal(values.download_concurrency, 3);
  assert.equal(values.manifest_ttl_hours, 0.025);
  await updateSettings(client, { manifest_poll_seconds: 60 });
  assert.equal(shared.manifestTTL, 90000);
  assert.equal(shared.downloadConcurrency, 3);
  const persisted = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(persisted.download_concurrency, 8, "unrelated CLI override must not be persisted");
  assert.equal(persisted.manifest_ttl_hours, 24);
  assert.equal(persisted.manifest_poll_seconds, 60);
});

test("settings updates stay consistent across existing and new sessions", async (t) => {
  writeFileSync(settingsPath, "{}");
  const shared = config();
  const a = await settingsSession(t, shared);
  const b = await settingsSession(t, shared);
  await updateSettings(a, { download_concurrency: 5 });
  assert.equal((await readSettings(b)).download_concurrency, 5);
  await updateSettings(b, { download_timeout_seconds: 45 });
  assert.equal(shared.downloadConcurrency, 5);
  const values = await readSettings(a);
  assert.equal(values.download_concurrency, 5);
  assert.equal(values.download_timeout_seconds, 45);
  const c = await settingsSession(t, shared);
  assert.deepEqual(await readSettings(c), values);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    download_concurrency: 5, download_timeout_seconds: 45,
  });
});

test("invalid persisted fields and invalid updates leave effective settings intact", async (t) => {
  writeFileSync(settingsPath, JSON.stringify({ cn_mirror: true, download_concurrency: 900, manifest_poll_seconds: 60 }));
  const shared = config();
  applyPersistedSettingsAtStartup(shared);
  const client = await settingsSession(t, shared);
  assert.equal(shared.downloadConcurrency, 16);
  assert.equal(shared.manifestPollMs, 60000);
  const before = await readSettings(client);
  const result = await client.callTool({ name: "settings.update", arguments: { set: { download_concurrency: 900 } } });
  assert.equal(result.isError, true);
  assert.deepEqual(await readSettings(client), before);
  await updateSettings(client, { download_timeout_seconds: 1 });
  assert.equal(shared.downloadTimeout, 1000);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { manifest_poll_seconds: 60, download_timeout_seconds: 1 });
});

test("mention links and resource catalog round-trip names with URI-reserved characters", async (t) => {
  const loaded = [];
  const loader = { readInstructionsWithState: async (entry) => { loaded.push(entry.name); return { instructions: `Instructions for ${entry.name}`, cache: { complete: true } }; } };
  const client = await session(t, (server, extensions) => registerOpenAIMentions(
    server, extensions, config(), new SkillSearchEngine(manifest), loader
  ));
  const { resources } = await client.listResources();
  assert.equal(resources.length, names.length);
  for (const resource of resources) {
    assert.equal(resource.uri, `skill://${encodeURIComponent(resource.name)}`);
    const result = await client.readResource({ uri: resource.uri });
    assert.match(result.contents[0].text, /Instructions for/);
    assert.equal(loaded.at(-1), resource.name);
  }
  const mentions = await client.callTool({ name: "search_mentions", arguments: { query: "" } });
  for (const item of mentions.structuredContent.items) {
    assert.equal(item.uri, `skill://${encodeURIComponent(item.name)}`);
    new URL(item.uri);
  }
});

test("supporting resource paths decode once and malformed encoding fails cleanly", async (t) => {
  const files = [];
  const loader = { loadSkillFile: async (entry, path) => {
    files.push([entry.name, path]);
    return {
      content: "fixture file", size_bytes: 12, offset: 0, bytes_returned: 12,
      has_more: false, binary: false,
    };
  } };
  const client = await session(t, (server, extensions) => registerOpenAIMentions(
    server, extensions, config(), new SkillSearchEngine(manifest), loader
  ));
  const name = names[4];
  const path = "references/中文 #100%2F.md";
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const result = await client.readResource({ uri: `skill://${encodeURIComponent(name)}/${encodedPath}` });
  assert.deepEqual(files, [[name, path]]);
  assert.equal(result.contents[0].mimeType, "text/markdown");
  assert.match(result.contents[0].text, /^## .+\(12 bytes; bytes 0–11\)\n\nfixture file$/);
  await assert.rejects(client.readResource({ uri: "skill://bad%ZZ" }), /Invalid percent-encoding/);
});

test("preferred skill README selects a Chinese variant before English", async (t) => {
  const requested = [];
  const loader = {
    listSkillFiles: async () => [
      { name: "README.md", type: "file", size_bytes: 10 },
      { name: "README_EN.md", type: "file", size_bytes: 12 },
      { name: "README.zh-TW.md", type: "file", size_bytes: 14 },
      { name: "README.zh-CN.md", type: "file", size_bytes: 16 },
    ],
    loadSkillFile: async (_entry, path) => {
      requested.push(path);
      return {
        content: "# 中文说明", size_bytes: 17, offset: 0, bytes_returned: 17,
        has_more: false, binary: false,
      };
    },
  };
  const client = await session(t, (server, extensions) => registerOpenAIMentions(
    server, extensions, config(), new SkillSearchEngine(manifest), loader
  ));
  const result = await client.readResource({
    uri: `skill://${encodeURIComponent(names[0])}/README.md`,
    _meta: {
      "codex-skills/display": "readme",
      "codex-skills/preferred-language": "zh-CN",
    },
  });
  assert.deepEqual(requested, ["README.zh-CN.md"]);
  assert.equal(result.contents[0].text, "# 中文说明");
  assert.equal(result.contents[0]._meta["codex-skills/readme-path"], "README.zh-CN.md");
});

test("an explicit Chinese README resource is rendered without a file wrapper", async (t) => {
  const requested = [];
  const loader = {
    listSkillFiles: async () => {
      throw new Error("an explicit README path should not trigger discovery");
    },
    loadSkillFile: async (_entry, path) => {
      requested.push(path);
      return {
        content: "# 中文说明\n\n直接显示这个版本。", size_bytes: 31, offset: 0, bytes_returned: 31,
        has_more: false, binary: false,
      };
    },
  };
  const client = await session(t, (server, extensions) => registerOpenAIMentions(
    server, extensions, config(), new SkillSearchEngine(manifest), loader
  ));
  const result = await client.readResource({
    uri: `skill://${encodeURIComponent(names[0])}/README_zh.md`,
    _meta: {
      "codex-skills/display": "readme",
      "codex-skills/preferred-language": "zh-CN",
    },
  });
  assert.deepEqual(requested, ["README_zh.md"]);
  assert.equal(result.contents[0].text, "# 中文说明\n\n直接显示这个版本。");
  assert.equal(result.contents[0]._meta["codex-skills/readme-path"], "README_zh.md");
});

test("resource materialization has a bounded deadline and can be retried", async (t) => {
  let ready = false;
  const loader = { readInstructionsWithState: async () => ready ? { instructions: "ready", cache: { complete: true } } : new Promise(() => {}) };
  const client = await session(t, (server, extensions) => registerOpenAIMentions(
    server, extensions, config({ softDeadlineMs: 20, hardDeadlineMs: 80 }), new SkillSearchEngine(manifest), loader
  ));
  const uri = `skill://${encodeURIComponent(names[0])}`;
  const started = performance.now();
  await assert.rejects(client.readResource({ uri }), /still in progress.*Retry/);
  assert.ok(performance.now() - started < 1000);
  ready = true;
  assert.match((await client.readResource({ uri })).contents[0].text, /ready/);
});

test("supporting file reads honor the hard deadline when soft deadline is disabled", async (t) => {
  const loader = { loadSkillFile: async () => new Promise(() => {}) };
  const client = await session(t, (server, extensions) => registerOpenAIMentions(
    server, extensions, config({ softDeadlineMs: 0, hardDeadlineMs: 20 }), new SkillSearchEngine(manifest), loader
  ));
  await assert.rejects(
    client.readResource({ uri: `skill://${encodeURIComponent(names[0])}/README.md` }),
    /still in progress.*Retry/
  );
});

test("cancelled resource reads settle promptly without keeping a deadline timer alive", async (t) => {
  let started;
  const downloadStarted = new Promise((resolve) => { started = resolve; });
  const loader = { readInstructionsWithState: async () => { started(); return new Promise(() => {}); } };
  const client = await session(t, (server, extensions) => registerOpenAIMentions(
    server, extensions, config({ softDeadlineMs: 55000, hardDeadlineMs: 285000 }), new SkillSearchEngine(manifest), loader
  ));
  const cancellation = new AbortController();
  const pending = client.readResource(
    { uri: `skill://${encodeURIComponent(names[0])}` },
    { signal: cancellation.signal }
  );
  await downloadStarted;
  const rejected = assert.rejects(pending, /abort|cancel/i);
  cancellation.abort();
  await rejected;
  assert.equal((await client.listResources()).resources.length, names.length);
});
