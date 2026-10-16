import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SkillLoader } from "../dist/loader/index.js";
import { registerOpenAIMentions } from "../dist/openai/mentions.js";

const entry = { name: "preview-demo", description: "preview fixture", category: "test",
  folder: "demo", relative_path: "./demo" };

function setup(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-loader-preview-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  t.after(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
  return { skillsDir: root, manifestPath: join(root, "skills_manifest.json"), isRemote: false,
    githubRepo: "preview/fixture", githubBranch: "main", githubPath: "skills",
    useOfficialMirror: false, hedgeEnabled: false, downloadConcurrency: 3, downloadTimeout: 1000,
    manifestTTL: 0, manifestPollMs: 0, softDeadlineMs: 0, hardDeadlineMs: 0, ...overrides };
}

function writeSkill(config, contents) {
  for (const [path, content] of Object.entries(contents)) {
    const target = join(config.skillsDir, entry.relative_path, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function remoteFixture(config, contents) {
  const files = Object.entries(contents).map(([path, content]) => ({
    path, size: Buffer.byteLength(content), mode: "100644",
    sha: createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex"),
  }));
  const catalog = Buffer.from(JSON.stringify({ version: 1, skill_path: entry.relative_path, files }) + "\n");
  const digest = createHash("sha256").update(catalog).digest("hex");
  const indexed = { ...entry, file_index: { path: `.catalog/${digest}.json`, sha256: digest,
    file_count: files.length, total_bytes: files.reduce((sum, file) => sum + file.size, 0) } };
  const requests = [];
  let beforeFile = async () => {};
  let fileContent = (path) => contents[path];
  globalThis.fetch = async (url) => {
    const pathname = decodeURIComponent(new URL(url).pathname);
    requests.push(pathname);
    if (pathname.endsWith(indexed.file_index.path)) return new Response(catalog);
    const path = Object.keys(contents).find((candidate) => pathname.endsWith(`/demo/${candidate}`));
    if (path) { await beforeFile(path); return new Response(fileContent(path)); }
    // A deliberately corrupt raw response also exercises the immutable blob
    // fallback. It must reject bytes that do not match the catalog's Git SHA.
    if (pathname.includes("/git/blobs/")) return new Response("invalid blob bytes");
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return { entry: indexed, requests,
    beforeFile: (callback) => { beforeFile = callback; },
    fileContent: (callback) => { fileContent = callback; },
  };
}

function resource(config, loader, selected = entry) {
  const handlers = new Map();
  const usage = [];
  registerOpenAIMentions(
    { registerResource: (name, ...args) => handlers.set(name, args.at(-1)) },
    { mentions: { setHandler() {} } }, config,
    { findByName: (name) => name === selected.name ? selected : undefined,
      getButlerEntry: () => selected.name === "00_codex_skills" ? selected : undefined,
      defaultSuggestions: () => [selected], recordUsage: (name) => usage.push(name) }, loader
  );
  return { usage, read: (signal = new AbortController().signal) => handlers.get("skill")(
    new URL(`skill://${encodeURIComponent(selected.name)}`), { name: encodeURIComponent(selected.name) }, { signal }
  ) };
}

function rejectMetadataScans(t, loader) {
  t.mock.method(loader, "scanStructure", () => assert.fail("instructions must not scan the directory tree"));
  t.mock.method(loader, "detectDependencies", () => assert.fail("instructions must not detect dependencies"));
}

test("instructions read preserves full text without structure, dependency or file-size limits", async (t) => {
  const config = setup(t);
  const instructions = "# Instructions\n" + "large instructions\n".repeat(32_000);
  writeSkill(config, { "SKILL.md": instructions, "requirements.txt": "example",
    "nested/SKILL.md": "---\nname: child\ndescription: child instructions\n---" });
  const loader = new SkillLoader(config, [entry]);
  rejectMetadataScans(t, loader);
  assert.equal(await loader.readInstructions(entry), instructions);
  const result = await resource(config, loader).read();
  assert.ok(result.contents[0].text.startsWith(instructions));
  assert.ok(result.contents[0].text.includes("Supporting files"));
  assert.ok(result.contents[0].text.includes("skill://preview-demo/<relative-path>"));
});

test("full read_skill still returns instructions, nested skills and dependency setup", async (t) => {
  const config = setup(t);
  writeSkill(config, { "SKILL.md": "# root", "requirements.txt": "example",
    "nested/SKILL.md": "---\nname: child\ndescription: child instructions\n---" });
  const loader = new SkillLoader(config, [entry]);
  const result = await loader.readSkill(entry);
  assert.equal(result.instructions, "# root");
  assert.deepEqual(result.dependencies, { language: "python", package_manager: "pip",
    setup_command: "pip install -r requirements.txt" });
  assert.deepEqual(result.structure.sub_skills, [{ name: "child", path: "nested", description: "child instructions" }]);
  assert.ok(result.structure.files.some((file) => file.name === "requirements.txt" && file.size_bytes === 7));
});

test("instructions reject a missing root file and escaping paths", async (t) => {
  const config = setup(t);
  const loader = new SkillLoader(config, [entry]);
  await assert.rejects(loader.readInstructions(entry), /SKILL.md not found/);
  await assert.rejects(loader.readInstructions({ ...entry, relative_path: "../escape" }), /Path traversal/);
  writeFileSync(join(config.skillsDir, "outside.md"), "outside skill directory");
  mkdirSync(join(config.skillsDir, "demo"));
  symlinkSync(join(config.skillsDir, "outside.md"), join(config.skillsDir, "demo/SKILL.md"));
  await assert.rejects(loader.readInstructions(entry), /symlink leaves its directory/);
});

test("instructions fully materialize supporting files and repair missing or truncated cached files", async (t) => {
  const config = setup(t, { isRemote: true });
  const contents = { "SKILL.md": "# remote instructions", "scripts/run.py": "print('ready')\n",
    "references/guide.md": "full supporting guide" };
  const fixture = remoteFixture(config, contents);
  const loader = new SkillLoader(config, [fixture.entry]);
  rejectMetadataScans(t, loader);
  const preview = resource(config, loader, fixture.entry);
  assert.ok((await preview.read()).contents[0].text.startsWith(contents["SKILL.md"]));
  for (const [path, content] of Object.entries(contents)) {
    assert.equal(readFileSync(join(config.skillsDir, "demo", path), "utf8"), content);
  }
  assert.equal(loader.cacheState(fixture.entry).complete, true);
  fixture.requests.length = 0;
  rmSync(join(config.skillsDir, "demo/scripts/run.py"));
  writeFileSync(join(config.skillsDir, "demo/references/guide.md"), "bad");
  await preview.read();
  assert.equal(readFileSync(join(config.skillsDir, "demo/scripts/run.py"), "utf8"), contents["scripts/run.py"]);
  assert.equal(readFileSync(join(config.skillsDir, "demo/references/guide.md"), "utf8"), contents["references/guide.md"]);
  assert.equal(loader.cacheState(fixture.entry).complete, true);
  assert.equal(fixture.requests.filter((path) => path.endsWith("/SKILL.md")).length, 0);
  assert.ok(fixture.requests.some((path) => path.endsWith("/scripts/run.py")));
  assert.ok(fixture.requests.some((path) => path.endsWith("/references/guide.md")));
  assert.ok(fixture.requests.every((path) => path.endsWith("/scripts/run.py") || path.endsWith("/references/guide.md")));
  fixture.requests.length = 0;
  await preview.read();
  assert.equal(fixture.requests.length, 0, "a complete warm preview stays offline");
});

test("instructions reject corrupted supporting downloads even when SKILL.md is ready", async (t) => {
  const config = setup(t, { isRemote: true });
  const contents = { "SKILL.md": "# ready", "support.md": "good" };
  const fixture = remoteFixture(config, contents);
  fixture.fileContent((path) => path === "support.md" ? "evil" : contents[path]);
  const loader = new SkillLoader(config, [fixture.entry]);
  const preview = resource(config, loader, fixture.entry);
  await assert.rejects(preview.read(), /SHA mismatch|downloads failed/);
  assert.equal(loader.cacheState(fixture.entry).complete, false);
  assert.deepEqual(preview.usage, [], "failed materialization must not count as a successful read");
  fixture.fileContent((path) => contents[path]);
  assert.ok((await preview.read()).contents[0].text.startsWith(contents["SKILL.md"]));
  assert.equal(loader.cacheState(fixture.entry).complete, true);
});

for (const mode of ["soft deadline", "hard deadline", "cancellation"]) {
  test(`resource instructions preserve ${mode} during full materialization and permit retry`, async (t) => {
    const config = setup(t, { isRemote: true, softDeadlineMs: mode === "soft deadline" ? 20 : 0,
      hardDeadlineMs: mode === "hard deadline" ? 20 : 5000 });
    const fixture = remoteFixture(config, { "SKILL.md": "# root", "support.md": "support" });
    let release;
    let started;
    const blocked = new Promise((resolve) => { release = resolve; });
    const downloading = new Promise((resolve) => { started = resolve; });
    fixture.beforeFile(async (path) => { if (path === "support.md") { started(); await blocked; } });
    const loader = new SkillLoader(config, [fixture.entry]);
    rejectMetadataScans(t, loader);
    const preview = resource(config, loader, fixture.entry);
    const controller = new AbortController();
    const pending = preview.read(controller.signal);
    const rejection = assert.rejects(pending, mode === "cancellation" ? /cancelled/ : (error) => {
      assert.equal(error.data.code, "DOWNLOAD_PENDING");
      assert.equal(error.data.retryable, true);
      return true;
    });
    try {
      await downloading;
      if (mode === "cancellation") controller.abort();
      await rejection;
      assert.deepEqual(preview.usage, []);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
      release();
    }
    assert.match((await preview.read()).contents[0].text, /# root/);
    assert.equal(loader.cacheState(fixture.entry).complete, true);
    assert.deepEqual(preview.usage, [entry.name]);
  });
}

test("pre-cancelled resources do not start materialization", async (t) => {
  const config = setup(t, { isRemote: true });
  const fixture = remoteFixture(config, { "SKILL.md": "# root" });
  const preview = resource(config, new SkillLoader(config, [fixture.entry]), fixture.entry);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(preview.read(controller.signal), /abort/i);
  assert.deepEqual(fixture.requests, []);
});

test("root router still serves only its root SKILL.md and the MCP guidance", async (t) => {
  const config = setup(t, { isRemote: true });
  const butler = { ...entry, name: "00_codex_skills", relative_path: "./" };
  writeFileSync(join(config.skillsDir, "SKILL.md"), "# Router");
  const loader = new SkillLoader(config, [butler]);
  t.mock.method(loader, "readInstructionsWithState", () => assert.fail("router must not materialize the library"));
  const result = await resource(config, loader, butler).read();
  assert.match(result.contents[0].text, /^# Router/);
  assert.match(result.contents[0].text, /MCP host note/);
});
