import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SkillLoader } from "../dist/loader/index.js";
import { registerReadSkill } from "../dist/tools/read-skill.js";
import { registerOpenAIMentions } from "../dist/openai/mentions.js";
import { finishSkillDownloadProgress, reportSkillDownloadProgress } from "../dist/remote/skill-progress.js";

const entry = { name: "materialized-demo", description: "fixture", category: "test", folder: "demo", relative_path: "./demo" };
const child = (name, description = "child instructions") => `---\nname: ${name}\ndescription: ${description}\n---\nExecute all steps.\n`;
const sha = (body) => createHash("sha1").update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest("hex");

function fixture(t, contents, overrides = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "codex-loader-materialized-"));
  const originalFetch = globalThis.fetch;
  const config = { skillsDir: root, manifestPath: join(root, "skills_manifest.json"), isRemote: true,
    githubRepo: "materialized/fixture", githubBranch: "main", githubPath: "skills",
    useOfficialMirror: false, hedgeEnabled: false, downloadConcurrency: 3, downloadTimeout: 500,
    manifestTTL: 0, manifestPollMs: 0, softDeadlineMs: 0, hardDeadlineMs: 0, ...overrides };
  const directory = join(root, "demo");
  const files = Object.entries(contents).map(([path, content]) => {
    const target = join(directory, path);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    fs.chmodSync(target, 0o644);
    return { path, size: Buffer.byteLength(content), sha: sha(content), mode: "100644" };
  });
  const marker = { version: 1, files, completedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
    source: { repo: config.githubRepo, branch: config.githubBranch, path: config.githubPath } };
  const markerPath = join(directory, ".codex-skills.tree.json");
  const saveMarker = () => fs.writeFileSync(markerPath, JSON.stringify(marker));
  saveMarker();
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  t.after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); });
  return { config, directory, marker, markerPath, saveMarker, loader: new SkillLoader(config, [entry]) };
}

async function countFs(operation) {
  const calls = { syncDirectories: 0, syncFiles: 0, asyncFiles: [], maxActive: 0 };
  let active = 0;
  const originals = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, readFile: fs.promises.readFile };
  fs.readdirSync = (...args) => { calls.syncDirectories++; return originals.readdirSync(...args); };
  fs.readFileSync = (...args) => { calls.syncFiles++; return originals.readFileSync(...args); };
  fs.promises.readFile = async (...args) => {
    calls.asyncFiles.push(String(args[0]));
    active++;
    calls.maxActive = Math.max(calls.maxActive, active);
    try { return await originals.readFile(...args); } finally { active--; }
  };
  syncBuiltinESMExports();
  try { return { result: await operation(), calls }; } finally {
    fs.readdirSync = originals.readdirSync;
    fs.readFileSync = originals.readFileSync;
    fs.promises.readFile = originals.readFile;
    syncBuiltinESMExports();
  }
}

test("catalog tree keeps its depth and visibility rules while subskills extend beyond depth five", async (t) => {
  const contents = {
    "SKILL.md": "# root instructions", "requirements.txt": "example", "README.md": "guide",
    "alpha/SKILL.md": child("alpha"), "alpha/sub/SKILL.md": child("sub"),
    "alpha/sub/deeper/SKILL.md": child("deeper"),
    "alpha/sub/deeper/four/five/SKILL.md": child("five"),
    "alpha/sub/deeper/four/five/six/SKILL.md": child("six"),
    ".private/SKILL.md": child("hidden subskill"), ".private/readme.md": "hidden",
    ".env.example": "SAMPLE=1", "node_modules/skip/SKILL.md": child("skipped"),
    "dist/SKILL.md": child("also skipped"), "zero.txt": "", "zeta/SKILL.md": "plain instruction",
  };
  const { loader, directory } = fixture(t, contents);
  const expected = loader.scanStructure(directory, entry);
  expected.sub_skills.splice(expected.sub_skills.findIndex(item => item.name === "five") + 1, 0,
    { name: "six", path: "alpha/sub/deeper/four/five/six", description: "child instructions" });
  const { result, calls } = await countFs(() => loader.readSkill(entry));
  assert.deepEqual(result.structure, expected);
  assert.equal(result.instructions, contents["SKILL.md"]);
  assert.equal(result.dependencies.setup_command, "pip install -r requirements.txt");
  assert.equal(result.cache.complete, true);
  assert.equal(calls.syncDirectories, 0, "validated file lists replace all recursive directory reads");
  assert.equal(calls.syncFiles, 1, "only the completion marker is read synchronously");
  assert.ok(calls.asyncFiles.some((path) => path.endsWith("alpha/SKILL.md")));
});

test("remote structures describe registered files while editable local mode includes additions", async (t) => {
  const { loader, directory, config } = fixture(t, { "SKILL.md": "root", "known/SKILL.md": child("known") });
  fs.mkdirSync(join(directory, "new-local"));
  fs.writeFileSync(join(directory, "new-local/SKILL.md"), child("local addition"));
  fs.mkdirSync(join(directory, "empty-local"));
  const remote = await loader.readSkill(entry);
  assert.deepEqual(remote.structure.sub_skills.map((item) => item.name), ["known"]);
  assert.equal(remote.structure.files.some((item) => item.name === "new-local"), false);
  const local = new SkillLoader({ ...config, isRemote: false }, [entry]);
  const first = await local.readSkill(entry);
  assert.deepEqual(first.structure, local.scanStructure(directory, entry));
  assert.ok(first.structure.files.some((item) => item.name === "empty-local"));
  assert.ok(first.structure.sub_skills.some((item) => item.name === "local addition"));
  fs.writeFileSync(join(directory, "known/SKILL.md"), child("local edit"));
  fs.rmSync(join(directory, "new-local"), { recursive: true });
  const second = await local.readSkill(entry);
  assert.deepEqual(second.structure.sub_skills.map((item) => item.name), ["local edit"]);
  assert.deepEqual(second.structure, local.scanStructure(directory, entry));
});

test("summary cache reuses warm content and invalidates same-size edits even with restored mtime", async (t) => {
  const { loader, directory } = fixture(t, { "SKILL.md": "root", "child/SKILL.md": child("first") });
  await loader.readSkill(entry);
  const warm = await countFs(() => loader.readSkill(entry));
  assert.equal(warm.calls.asyncFiles.filter((path) => path.endsWith("child/SKILL.md")).length, 0);
  const path = join(directory, "child/SKILL.md");
  const previous = fs.statSync(path);
  fs.writeFileSync(path, child("other"));
  fs.utimesSync(path, previous.atime, previous.mtime);
  const edited = await countFs(() => loader.readSkill(entry));
  assert.equal(edited.result.structure.sub_skills[0].name, "other");
  assert.equal(edited.calls.asyncFiles.filter((file) => file === fs.realpathSync(path)).length, 1);
});

test("remote cache clearing removes only that skill directory and is idempotent", async (t) => {
  const { loader, directory } = fixture(t, {
    "SKILL.md": "# root",
    "nested/data.txt": "payload",
  });
  const marker = fs.readFileSync(join(directory, ".codex-skills.tree.json"), "utf8");
  assert.match(marker, /completedAt/);
  const first = await loader.clearCache(entry);
  assert.equal(first.cleared, true);
  assert.equal(first.files_removed, 2);
  assert.ok(first.bytes_removed > 0);
  assert.equal(fs.existsSync(directory), false);
  const second = await loader.clearCache(entry);
  assert.equal(second.cleared, false);
  assert.equal(second.files_removed, 0);
});

test("cache clearing rejects local libraries, active downloads and symlink targets", async (t) => {
  const local = fixture(t, { "SKILL.md": "# root" });
  const localLoader = new SkillLoader({ ...local.config, isRemote: false }, [entry]);
  await assert.rejects(localLoader.clearCache(entry), /本地技能目录/);
  assert.equal(fs.existsSync(local.directory), true);

  const active = fixture(t, { "SKILL.md": "# root" });
  reportSkillDownloadProgress(entry.name, 0, 1, "starting");
  await assert.rejects(active.loader.clearCache(entry), /正在下载/);
  finishSkillDownloadProgress(entry.name);
  assert.equal(fs.existsSync(active.directory), true);

  const linked = fixture(t, { "SKILL.md": "# root" });
  const outside = join(linked.config.skillsDir, "outside");
  fs.mkdirSync(outside);
  fs.rmSync(linked.directory, { recursive: true, force: true });
  fs.symlinkSync(outside, linked.directory);
  await assert.rejects(linked.loader.clearCache(entry), /Symbolic|Symlink|符号链接/i);
  assert.equal(fs.existsSync(outside), true);

  const rootEntry = { ...entry, name: "root-router", relative_path: "./" };
  await assert.rejects(active.loader.clearCache(rootEntry), /根入口|root/i);
  assert.equal(fs.existsSync(active.config.skillsDir), true);
});

test("summary cache is bound to source identity and catalog content SHA", async (t) => {
  const { loader, config, marker, saveMarker } = fixture(t, { "SKILL.md": "root", "child/SKILL.md": child("first") });
  await loader.readSkill(entry);
  config.githubBranch = "another-source";
  marker.source.branch = config.githubBranch;
  saveMarker();
  const switched = await countFs(() => loader.readSkill(entry));
  assert.equal(switched.calls.asyncFiles.filter((path) => path.endsWith("child/SKILL.md")).length, 1);
  marker.files.find((file) => file.path === "child/SKILL.md").sha = sha("changed catalog identity");
  saveMarker();
  const revision = await countFs(() => loader.readSkill(entry));
  assert.equal(revision.calls.asyncFiles.filter((path) => path.endsWith("child/SKILL.md")).length, 1);
});

test("a deleted registered subskill is repaired before a complete full read", async (t) => {
  const contents = { "SKILL.md": "root", "child/SKILL.md": child("restored") };
  const { loader, directory } = fixture(t, contents);
  await loader.readSkill(entry);
  fs.rmSync(join(directory, "child/SKILL.md"));
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    assert.ok(String(url).endsWith("/child/SKILL.md"));
    return new Response(contents["child/SKILL.md"]);
  };
  const result = await loader.readSkill(entry);
  assert.ok(requests.length > 0);
  assert.equal(result.cache.complete, true);
  assert.deepEqual(result.cache.filesMissing, []);
  assert.equal(result.structure.sub_skills[0].name, "restored");
});

test("initial subskill reads are asynchronous and bounded across concurrent requests", async (t) => {
  const contents = { "SKILL.md": "root" };
  for (let i = 0; i < 96; i++) contents[`child-${String(i).padStart(3, "0")}/SKILL.md`] = child(`child ${i}`);
  const { loader } = fixture(t, contents);
  let timerRan = false;
  const timer = new Promise((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 0));
  const { result, calls } = await countFs(() => Promise.all([loader.readSkill(entry), loader.readSkill(entry)]));
  assert.ok(timerRan, "initial async reads allow a timer to run before both responses finish");
  await timer;
  assert.equal(result[0].structure.sub_skills.length, 96);
  assert.equal(result[1].structure.sub_skills.length, 96);
  assert.ok(calls.maxActive <= 8, `observed ${calls.maxActive} concurrent async reads`);
  assert.ok(calls.maxActive >= 2);
  assert.equal(calls.syncDirectories, 0);
});

test("oversized summaries respect the memory budget without dropping output", async (t) => {
  const description = "d".repeat(4 * 1024 * 1024 + 1);
  const { loader } = fixture(t, { "SKILL.md": "root", "huge/SKILL.md": child("huge", description) });
  const first = await loader.readSkill(entry);
  const second = await countFs(() => loader.readSkill(entry));
  assert.equal(first.structure.sub_skills[0].description, description);
  assert.equal(second.result.structure.sub_skills[0].description, description);
  assert.equal(second.calls.asyncFiles.filter((path) => path.endsWith("huge/SKILL.md")).length, 1);
});

test("symlink escapes never enter local subskill summaries", async (t) => {
  const { config, directory } = fixture(t, { "SKILL.md": "root", "valid/SKILL.md": child("valid") }, { isRemote: false });
  const outside = join(config.skillsDir, "outside.md");
  fs.writeFileSync(outside, child("escaped secret"));
  fs.mkdirSync(join(directory, "escape"));
  fs.symlinkSync(outside, join(directory, "escape/SKILL.md"));
  const loader = new SkillLoader(config, [entry]);
  assert.deepEqual((await loader.readSkill(entry)).structure.sub_skills.map((item) => item.name), ["valid"]);
});

test("read_skill reuses the materialization state and preserves instructions and tree output", async (t) => {
  const { loader } = fixture(t, { "SKILL.md": "# Full instruction text", "child/SKILL.md": child("child") });
  t.mock.method(loader, "cacheState", () => assert.fail("tool must not repeat a deep check"));
  let handler;
  registerReadSkill({ tool: (...args) => { handler = args.at(-1); } }, { findByName: () => entry }, loader);
  const result = await handler({ name: entry.name }, { signal: new AbortController().signal });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Full instruction text/);
  assert.match(result.content[0].text, /complete — 2 files/);
  assert.match(result.content[0].text, /Sub-Skills/);
  assert.match(result.content[0].text, /child instructions/);
});

test("resource instructions identify a cached revision after a failed catalog refresh", async (t) => {
  const { loader, config } = fixture(t, { "SKILL.md": "# Cached instructions" });
  const updated = { ...entry, file_index: { path: ".catalog/next.json", sha256: "a".repeat(64), file_count: 1, total_bytes: 4 } };
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const resources = new Map();
  registerOpenAIMentions({ registerResource: (name, ...args) => resources.set(name, args.at(-1)) },
    { mentions: { setHandler() {} } }, config, { findByName: () => updated, getButlerEntry: () => undefined }, loader);
  const result = await resources.get("skill")(new URL(`skill://${entry.name}`), { name: entry.name }, { signal: new AbortController().signal });
  assert.match(result.contents[0].text, /Cached instructions/);
  assert.match(result.contents[0].text, /Cached revision.*current manifest catalog not validated/);
});

test("a marker revision changed during async reads triggers a consistent reread", async (t) => {
  const { loader, directory, marker, saveMarker } = fixture(t, { "SKILL.md": "old root", "child/SKILL.md": child("first") });
  const original = fs.promises.readFile;
  let changed = false;
  fs.promises.readFile = async (...args) => {
    const data = await original(...args);
    if (!changed && basename(String(args[0])) === "SKILL.md") {
      changed = true;
      fs.writeFileSync(join(directory, "SKILL.md"), "new root");
      marker.files.find((file) => file.path === "SKILL.md").sha = sha("new root");
      marker.completedAt = new Date(Date.now() + 1).toISOString();
      saveMarker();
    }
    return data;
  };
  syncBuiltinESMExports();
  try {
    const result = await loader.readSkill(entry);
    assert.equal(result.instructions, "new root");
    assert.equal(result.cache.completedAt, marker.completedAt);
  } finally { fs.promises.readFile = original; syncBuiltinESMExports(); }
});
