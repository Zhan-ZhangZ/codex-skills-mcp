import test from "node:test";
import assert from "node:assert/strict";
import { registerCodexSkillsApp } from "../dist/openai/app.js";
import { finishSkillDownloadProgress, reportSkillDownloadProgress } from "../dist/remote/skill-progress.js";

function fixtures() {
  const tools = new Map();
  const resources = new Map();
  const skills = [{ name: "alpha", description: "Alpha", category: "tools" }];
  const engine = {
    getCategories: () => [{ name: "tools", skill_count: 1 }],
    defaultSuggestions: () => skills,
    popularSkills: () => [{ entry: skills[0], reads: 7, failures: 1, last_read_at: 1_700_000_000_000 }],
    usageSummary: () => ({ total_reads: 7, used_skills: 1, total_failures: 1 }),
    usageFor: () => ({ reads: 7, failures: 1, last_read_at: 1_700_000_000_000 }),
    allSkills: () => skills,
    findByName: (name) => skills.find((item) => item.name === name),
    search: () => skills.map((item) => ({ ...item, score: 1 })),
    searchWithTotal: (_query, options = {}) => ({
      results: skills.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 20)),
      total: skills.length,
    }),
    // Never resolves: read-only UI requests must not wait for remote polling.
    maybeRefreshManifest: () => new Promise(() => {}),
  };
  const loader = {
    cacheMode: "remote",
    isCached: () => true,
    clearCache: async () => ({
      found: true, cleared: true, local_path: "/cache/alpha",
      files_removed: 4, bytes_removed: 2048,
    }),
  };
  assert.equal(registerCodexSkillsApp({
    registerTool: (name, config, handler) => tools.set(name, { config, handler }),
    registerResource: (name, uri, config, handler) => resources.set(name, { uri, config, handler }),
  }, engine, loader), true);
  return { tools, resources, loader, engine };
}

test("app-only tools expose standard read-only annotations and bounded input", () => {
  const { tools } = fixtures();
  for (const name of ["skills.browse", "skills.query", "skills.progress"]) {
    const config = tools.get(name).config;
    assert.equal(config.annotations.readOnlyHint, true);
    assert.equal(config.annotations.destructiveHint, false);
    assert.deepEqual(config._meta.ui.visibility, ["app"]);
  }
  const schema = tools.get("skills.query").config.inputSchema;
  assert.equal(schema.safeParse({ query: "   " }).success, false);
  assert.equal(schema.safeParse({ query: "x".repeat(501) }).success, false);
  assert.equal(schema.parse({ query: "  alpha  " }).query, "alpha");
  assert.equal(schema.safeParse({ query: "alpha", limit: 31 }).success, false);
  assert.equal(schema.safeParse({ query: "alpha", offset: 10001 }).success, false);
  assert.equal(schema.parse({ query: "alpha", offset: 12 }).offset, 12);
  const clear = tools.get("skills.clearCache").config;
  assert.equal(clear.annotations.readOnlyHint, false);
  assert.equal(clear.annotations.destructiveHint, true);
  assert.deepEqual(clear._meta.ui.visibility, ["app"]);
});

test("app progress tool returns the latest real download counters", async () => {
  const { tools } = fixtures();
  reportSkillDownloadProgress("alpha", 3, 9, "Fetching 3/9 files for alpha");
  const active = await tools.get("skills.progress").handler({ name: "alpha" });
  assert.deepEqual(active.structuredContent.progress, {
    name: "alpha", done: 3, total: 9, message: "Fetching 3/9 files for alpha",
    updated_at: active.structuredContent.progress.updated_at, active: true,
  });
  finishSkillDownloadProgress("alpha");
  const finished = await tools.get("skills.progress").handler({ name: "alpha" });
  assert.equal(finished.structuredContent.progress.active, false);
  assert.equal(finished.structuredContent.progress.done, 9);
});

test("app browsing and searching return immediately while freshness check is pending", async () => {
  const { tools, resources } = fixtures();
  const homepage = await tools.get("skills.browse").handler({});
  assert.equal(homepage.structuredContent.totalSkills, 1);
  assert.equal(homepage.structuredContent.top[0].cached, true);
  assert.equal(homepage.structuredContent.top[0].reads, 7);
  assert.equal(homepage.structuredContent.cache_mode, "remote");
  const category = await tools.get("skills.browse").handler({ category: "tools" });
  assert.equal(category.structuredContent.skills[0].name, "alpha");
  const search = await tools.get("skills.query").handler({ query: "alpha" });
  assert.equal(search.structuredContent.results[0].cached, true);
  assert.equal(search.structuredContent.total, 1);
  assert.equal(search.structuredContent.has_more, false);
  const resource = await resources.get("codex-skills-app").handler();
  assert.match(resource.contents[0].text, /ui\/initialize/);
  assert.doesNotMatch(resource.contents[0].text, /<!-- APP_(?:SCRIPT|STYLES) -->/);
});

test("home totals follow the current catalog instead of a fixed count", async () => {
  const { tools, engine } = fixtures();
  engine.getCategories = () => [
    { name: "tools", skill_count: 4 },
    { name: "research", skill_count: 7 },
  ];
  const first = await tools.get("skills.browse").handler({});
  assert.equal(first.structuredContent.totalSkills, 11);
  engine.getCategories = () => [{ name: "tools", skill_count: 2 }];
  const updated = await tools.get("skills.browse").handler({});
  assert.equal(updated.structuredContent.totalSkills, 2);
  assert.deepEqual(updated.structuredContent.categories, [{ name: "tools", skill_count: 2 }]);
});

test("app cache clearing preserves usage and reports removed files", async () => {
  const { tools } = fixtures();
  const result = await tools.get("skills.clearCache").handler({ name: "alpha" });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.cleared, true);
  assert.equal(result.structuredContent.files_removed, 4);
  assert.equal(result.structuredContent.cache_mode, "remote");

  const missing = await tools.get("skills.clearCache").handler({ name: "missing" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/i);
});
