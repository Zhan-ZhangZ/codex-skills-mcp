import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig, parseManifest, loadManifest } from "../dist/config.js";
import { SkillLoader } from "../dist/loader/index.js";
import { SkillSearchEngine } from "../dist/search/index.js";
import { registerSearchSkills } from "../dist/tools/search-skills.js";

const entry = (name, description, extra = {}) => ({
  name, description, category: "test", folder: name, relative_path: `./${name}`, ...extra,
});
const manifest = [
  entry("research", "Academic literature research 文献检索 论文研究", { aliases: ["papers"] }),
  entry("render", "Create visual charts and diagrams 图表制作", { aliases: ["slides"] }),
  entry("frontend", "Frontend performance profiling 前端性能优化"),
];

function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-core-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    skillsDir: root, manifestPath: join(root, "skills_manifest.json"), isRemote: false,
    githubRepo: "fixture/repository", githubBranch: "main", githubPath: "skills",
    useOfficialMirror: false, hedgeEnabled: false, downloadConcurrency: 4,
    downloadTimeout: 1000, manifestTTL: 86400000, manifestPollMs: 300000,
    softDeadlineMs: 100, hardDeadlineMs: 500, ...overrides,
  };
  writeFileSync(config.manifestPath, JSON.stringify(manifest));
  return config;
}

function isolateConfigEnvironment(t) {
  for (const key of ["CODEX_SKILLS_DIR", "CODEX_SKILLS_DOWNLOAD_CONCURRENCY", "CODEX_SKILLS_DOWNLOAD_TIMEOUT", "CODEX_SKILLS_MANIFEST_POLL_SECONDS", "GITHUB_TOKEN"]) {
    const original = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

async function searchClient(t, engine) {
  const server = new McpServer({ name: "search-test", version: "1.0.0" });
  registerSearchSkills(server, engine, { isCached: () => false });
  const client = new Client({ name: "search-test-client", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("rebuilding an index preserves scores and removes obsolete names, categories and butler", () => {
  const butler = entry("00_codex_skills", "Library router 管家", { category: "routing", relative_path: "./" });
  const engine = new SkillSearchEngine([...manifest, butler]);
  const queries = ["research", "文献检索", "frontend performance", "papres"];
  const before = queries.map((query) => engine.search(query));
  for (let i = 0; i < 12; i++) {
    engine.buildIndex([...manifest, butler]);
    assert.deepEqual(queries.map((query) => engine.search(query)), before);
    assert.equal(engine.allSkills().length, manifest.length);
  }
  assert.equal(engine.getButlerEntry(), butler);
  const replacement = entry("replacement", "New library entry", { category: "new category" });
  engine.buildIndex([replacement]);
  assert.equal(engine.getButlerEntry(), undefined);
  assert.equal(engine.findByName("research"), undefined);
  assert.equal(engine.findByName("replacement"), replacement);
  assert.deepEqual(engine.getCategories(), [{ name: "new category", skill_count: 1 }]);
});

test("case-insensitive exact lookup and two-edit fuzzy search remain compatible", () => {
  const engine = new SkillSearchEngine(manifest);
  assert.equal(engine.findByName("RESEARCH"), manifest[0]);
  assert.equal(engine.findByName("missing"), undefined);
  assert.deepEqual(engine.search("RESEARCH"), engine.search("research"));
  for (const query of ["researh", "researhc", "papres"]) {
    const result = engine.search(query);
    assert.equal(result[0]?.name, "research", query);
    assert.ok(result[0].matched_terms.some((term) => term.endsWith("(fuzzy)")), query);
  }
  assert.deepEqual(engine.search("zzzzzzzzzzzzzzzzzzzz"), []);
  assert.equal(engine.search("论文")[0]?.name, "research");
});

test("explicit refresh bypasses a fresh never-expiring manifest and rebuilds from remote bytes", async (t) => {
  const config = setup(t, { isRemote: true, manifestTTL: 0 });
  writeFileSync(join(config.skillsDir, ".codex-skills.source.json"), JSON.stringify({ repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath }));
  const updated = [...manifest, entry("new-skill", "New fixture skill")];
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify(updated), { headers: { etag: '"fixture-v2"' } });
  });
  const engine = new SkillSearchEngine(manifest, config);
  assert.equal(await engine.refreshManifest(), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "https://raw.githubusercontent.com/fixture/repository/main/skills/skills_manifest.json");
  assert.equal(engine.findByName("new-skill")?.description, "New fixture skill");
  assert.equal(config.manifestTTL, 0, "force refresh must not mutate TTL");
  assert.deepEqual(JSON.parse(readFileSync(config.manifestPath, "utf8")), updated);
});

test("search returns before a background refresh settles and misses never force downloads", { timeout: 2000 }, async (t) => {
  const engine = new SkillSearchEngine(manifest);
  let completeRefresh;
  const background = new Promise((resolve) => { completeRefresh = resolve; });
  let polls = 0;
  let forced = 0;
  engine.maybeRefreshManifest = () => { polls++; return background; };
  engine.refreshManifest = async () => { forced++; return false; };
  t.after(() => completeRefresh(false));
  const client = await searchClient(t, engine);
  const found = await client.callTool({ name: "search_skills", arguments: { query: "research" } });
  assert.match(found.content[0].text, /research/);
  const missed = await client.callTool({ name: "search_skills", arguments: { query: "zzzzzzzzzzzzzzzzzzzz" } });
  assert.match(missed.content[0].text, /No skills found/);
  assert.equal(polls, 2);
  assert.equal(forced, 0);
});

test("force_refresh tool awaits one explicit refresh and searches the resulting index", async (t) => {
  const engine = new SkillSearchEngine(manifest);
  let forced = 0;
  engine.maybeRefreshManifest = async () => { assert.fail("forced search must not also poll"); };
  engine.refreshManifest = async () => {
    forced++;
    await Promise.resolve();
    engine.buildIndex([...manifest, entry("newentry", "Newly published fixture")]);
    return true;
  };
  const client = await searchClient(t, engine);
  const result = await client.callTool({ name: "search_skills", arguments: { query: "newentry", force_refresh: true } });
  assert.equal(forced, 1);
  assert.ok(result.content[0].text.includes("**newentry**"));
});

test("search tool rejects empty, excessive and noninteger input bounds", async (t) => {
  const client = await searchClient(t, new SkillSearchEngine(manifest));
  for (const args of [{ query: " " }, { query: "x".repeat(4001) }, { query: "research", limit: 0 }, { query: "research", limit: 51 }, { query: "research", limit: 1.5 }]) {
    const result = await client.callTool({ name: "search_skills", arguments: args });
    assert.equal(result.isError, true);
  }
});

test("all numeric CLI options reject partial numbers and enforce both boundaries", (t) => {
  const config = setup(t);
  isolateConfigEnvironment(t);
  const base = ["--skills-dir", config.skillsDir];
  const options = [
    ["--soft-deadline-seconds", 0, 86400, "softDeadlineMs", 1000],
    ["--hard-deadline-seconds", 0, 86400, "hardDeadlineMs", 1000],
    ["--manifest-ttl", 0, 604800, "manifestTTL", 1000],
    ["--manifest-poll", 0, 3600, "manifestPollMs", 1000],
    ["--download-concurrency", 1, 64, "downloadConcurrency", 1],
    ["--download-timeout", 1, 300, "downloadTimeout", 1000],
  ];
  for (const [flag, min, max, field, scale] of options) {
    for (const value of ["12seconds", "1.5", "NaN", "Infinity", "1e2", " 1", "9007199254740993", String(min - 1), String(max + 1)]) {
      assert.throws(() => parseConfig([...base, flag, value]), new RegExp(flag), `${flag} ${value}`);
    }
    assert.throws(() => parseConfig([...base, flag]), /requires a value/);
    assert.throws(() => parseConfig([...base, flag, "--local"]), /requires a value/);
    assert.equal(parseConfig([...base, flag, String(min)])[field], min * scale);
    assert.equal(parseConfig([...base, flag, String(max)])[field], max * scale);
  }
});

test("numeric environment options validate and explicit CLI values take precedence", (t) => {
  const config = setup(t);
  isolateConfigEnvironment(t);
  const base = ["--skills-dir", config.skillsDir];
  for (const [environment, flag, field] of [
    ["CODEX_SKILLS_DOWNLOAD_CONCURRENCY", "--download-concurrency", "downloadConcurrency"],
    ["CODEX_SKILLS_DOWNLOAD_TIMEOUT", "--download-timeout", "downloadTimeout"],
    ["CODEX_SKILLS_MANIFEST_POLL_SECONDS", "--manifest-poll", "manifestPollMs"],
  ]) {
    process.env[environment] = "12invalid";
    assert.throws(() => parseConfig(base), new RegExp(flag));
    assert.equal(parseConfig([...base, flag, "2"])[field], field === "downloadConcurrency" ? 2 : 2000);
    delete process.env[environment];
  }
});

test("local CLI startup does not invoke git credential helpers", (t) => {
  const config = setup(t);
  isolateConfigEnvironment(t);
  const original = childProcess.execFileSync;
  let calls = 0;
  childProcess.execFileSync = () => { calls++; throw new Error("credential helper must not run"); };
  syncBuiltinESMExports();
  try {
    assert.equal(parseConfig(["--skills-dir", config.skillsDir]).isRemote, false);
    process.env.CODEX_SKILLS_DIR = config.skillsDir;
    assert.equal(parseConfig(["--local"]).isRemote, false);
    assert.equal(parseConfig([]).isRemote, false);
    assert.equal(calls, 0);
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
});

test("manifest boundary validates shape, duplicate names, metadata and path containment", (t) => {
  const config = setup(t);
  assert.deepEqual(loadManifest(config.manifestPath), manifest);
  assert.deepEqual(parseManifest([]), []);
  assert.deepEqual(parseManifest([entry("00_codex_skills", "Butler", { relative_path: "./" })]).length, 1);
  for (const value of [null, {}, "manifest", [null], [[]], [{ ...manifest[0], name: " " }],
    [{ ...manifest[0], description: 12 }], [{ ...manifest[0], aliases: "alias" }],
    [{ ...manifest[0], tags: [42] }], [{ ...manifest[0], dependencies: [null] }],
    [manifest[0], { ...manifest[0], name: "RESEARCH" }]]) {
    assert.throws(() => parseManifest(value), /Manifest|manifest/);
  }
  for (const relative_path of ["", "../outside", "./safe/../../outside", "/absolute", "C:/outside", "C:\\outside", "safe\\outside", "bad" + String.fromCharCode(0) + "name"]) {
    assert.throws(() => parseManifest([{ ...manifest[0], relative_path }]), /relative_path/);
  }
  writeFileSync(config.manifestPath, JSON.stringify([{ ...manifest[0], name: 123 }]));
  assert.throws(() => loadManifest(config.manifestPath), /name must be a string/);
});

test("loader rejects adjacent-prefix directories and symlink escapes for reads and listing", async (t) => {
  const config = setup(t);
  const skill = entry("demo", "Fixture");
  const skillDir = join(config.skillsDir, "demo");
  const outside = join(config.skillsDir, "demo-other");
  mkdirSync(skillDir);
  mkdirSync(outside);
  writeFileSync(join(skillDir, "SKILL.md"), "fixture instructions");
  writeFileSync(join(outside, "secret.txt"), "outside fixture");
  symlinkSync(outside, join(skillDir, "escape"), "dir");
  symlinkSync(join(outside, "secret.txt"), join(skillDir, "linked.txt"), "file");
  symlinkSync(join(skillDir, "SKILL.md"), join(skillDir, "internal.md"), "file");
  const loader = new SkillLoader(config, [skill]);
  assert.equal((await loader.loadSkillFile(skill, "SKILL.md")).content, "fixture instructions");
  assert.equal((await loader.loadSkillFile(skill, "internal.md")).content, "fixture instructions");
  for (const path of ["../demo-other/secret.txt", "escape/secret.txt", "escape/not-yet-created.txt", "linked.txt"]) {
    await assert.rejects(loader.loadSkillFile(skill, path), /Path traversal/);
  }
  for (const path of ["../demo-other", "escape", "escape/nonexistent"]) {
    await assert.rejects(loader.listSkillFiles(skill, path), /Path traversal/);
  }
  await assert.rejects(loader.listSkillFiles(skill, "SKILL.md"), /not a directory/);
  await assert.rejects(loader.loadSkillFile(skill, "."), /not a regular file/);
  assert.throws(() => loader.resolveSkillPath({ ...skill, relative_path: "../outside" }), /Path traversal/);
});
