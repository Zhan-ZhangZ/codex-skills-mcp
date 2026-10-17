import test from "node:test";
import assert from "node:assert/strict";
import { registerCodexSkillsApp } from "../dist/openai/app.js";

function fixtures() {
  const tools = new Map();
  const resources = new Map();
  const skills = [{ name: "alpha", description: "Alpha", category: "tools" }];
  const engine = {
    getCategories: () => [{ name: "tools", skill_count: 1 }],
    defaultSuggestions: () => skills,
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
  assert.equal(registerCodexSkillsApp({
    registerTool: (name, config, handler) => tools.set(name, { config, handler }),
    registerResource: (name, uri, config, handler) => resources.set(name, { uri, config, handler }),
  }, engine, { isCached: () => true }), true);
  return { tools, resources };
}

test("app-only tools expose standard read-only annotations and bounded input", () => {
  const { tools } = fixtures();
  for (const name of ["skills.browse", "skills.query"]) {
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
});

test("app browsing and searching return immediately while freshness check is pending", async () => {
  const { tools, resources } = fixtures();
  const homepage = await tools.get("skills.browse").handler({});
  assert.equal(homepage.structuredContent.totalSkills, 1);
  assert.equal(homepage.structuredContent.top[0].cached, true);
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
