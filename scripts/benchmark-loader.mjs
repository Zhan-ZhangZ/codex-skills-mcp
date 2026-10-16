#!/usr/bin/env node
/**
 * Offline loader benchmark against a read-only catalog-backed source checkout.
 *   node scripts/benchmark-loader.mjs --source-root /path/to/codex-skills
 *   node scripts/benchmark-loader.mjs --source-root /path/to/codex-skills \
 *     --baseline-dist /path/to/beta5/dist --samples 15 --output /tmp/loader.json
 *
 * The baseline dist needs its package.json (type: module) and dependencies in
 * an ancestor directory. Build the current dist before measuring. Both builds
 * use the same temporary fixture paths, with real SKILL.md bodies and sparse
 * placeholders for other files. The source checkout is never written to.
 * Timings cover warm handler execution, excluding JSON serialization and wire
 * transport. These are comparisons, not production latency thresholds.
 */
import fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

const { values } = parseArgs({ options: {
  "source-root": { type: "string" },
  "dist": { type: "string" },
  "baseline-dist": { type: "string" },
  "samples": { type: "string", default: "15" },
  "warmups": { type: "string", default: "3" },
  "skill": { type: "string", multiple: true },
  "output": { type: "string" },
  "help": { type: "boolean", short: "h" },
} });
if (values.help || !values["source-root"]) {
  console.log("Usage: node scripts/benchmark-loader.mjs --source-root SOURCE [--dist DIST] [--baseline-dist DIST] [--samples N] [--warmups N] [--skill NAME ...] [--output FILE]");
  process.exit(values.help ? 0 : 1);
}
const samples = Number(values.samples);
const warmups = Number(values.warmups);
if (!Number.isSafeInteger(samples) || samples < 1 || !Number.isSafeInteger(warmups) || warmups < 0) {
  throw new Error("samples must be a positive integer and warmups a nonnegative integer");
}
const sourceRoot = fs.realpathSync(resolve(values["source-root"]));
const currentDist = resolve(values.dist ?? fileURLToPath(new URL("../dist", import.meta.url)));
const names = values.skill ?? ["human-writing", "x-cmd", "Awesome-Journal-Skills"];
const manifest = JSON.parse(fs.readFileSync(join(sourceRoot, "skills_manifest.json"), "utf8"));
const scratch = fs.mkdtempSync(join(tmpdir(), "codex-loader-benchmark-"));
const report = {
  started_at: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  source_root: sourceRoot, samples_per_operation: samples, warmup_rounds: warmups, builds: [], skills: [],
  notes: [
    "Warm handler timings exclude JSON serialization, network transport and console.error mirroring.",
    "Remote fixtures have catalog paths, sizes and modes; only SKILL.md bodies are real. No source files are modified.",
    "Both builds use identical fixture paths. Local-source and remote-fixture paths differ; do not interpret their gap as an optimization.",
    "I/O counts are JavaScript fs API calls, not kernel syscalls. Synchronous and asynchronous calls are reported separately; timing and I/O counting run separately.",
    "Remote reads must stay offline and preserve complete cache state. Event-loop and concurrent-request probes are single observations.",
    "fresh_tool_read_skill uses a new loader per sample: the disk cache is complete, but the in-memory subskill summary cache is empty. This is not a network-cold download.",
  ],
};
const savedFetch = globalThis.fetch;
const savedError = console.error;
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error("Benchmark is offline; fixture validation attempted a network request"); };
console.error = () => {};

const config = (skillsDir, isRemote) => ({
  skillsDir, manifestPath: join(skillsDir, "skills_manifest.json"), isRemote,
  githubRepo: "benchmark/fixture", githubBranch: "main", githubPath: "skills",
  useOfficialMirror: false, hedgeEnabled: false, downloadConcurrency: 16, downloadTimeout: 1000,
  manifestTTL: 0, manifestPollMs: 0, softDeadlineMs: 0, hardDeadlineMs: 0,
});
const round = (value) => Math.round(value * 1000) / 1000;
function statistics(timings) {
  const sorted = [...timings].sort((a, b) => a - b);
  return { p50_ms: round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95_ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    mean_ms: round(timings.reduce((sum, value) => sum + value, 0) / timings.length),
    samples: timings.length, timings_ms: timings.map(round) };
}
async function measure(fn) {
  for (let i = 0; i < warmups; i++) await fn();
  const timings = [];
  let value;
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    value = await fn();
    timings.push(performance.now() - start);
  }
  return { ...statistics(timings), output_bytes: value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)) };
}
async function countIO(fn) {
  const methods = ["existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "readFileSync"];
  const asyncMethods = ["stat", "readdir", "realpath", "readFile"];
  const original = Object.fromEntries(methods.map((name) => [name, fs[name]]));
  const originalAsync = Object.fromEntries(asyncMethods.map((name) => [name, fs.promises[name]]));
  const counts = Object.fromEntries(methods.map((name) => [name, 0]));
  const asyncCounts = Object.fromEntries(asyncMethods.map((name) => [name, 0]));
  let activeAsync = 0;
  let maxActiveAsync = 0;
  const directories = new Map();
  for (const name of methods) fs[name] = (...args) => {
    counts[name]++;
    if (name === "readdirSync") directories.set(String(args[0]), (directories.get(String(args[0])) ?? 0) + 1);
    return original[name](...args);
  };
  for (const name of asyncMethods) fs.promises[name] = async (...args) => {
    asyncCounts[name]++;
    maxActiveAsync = Math.max(maxActiveAsync, ++activeAsync);
    try { return await originalAsync[name](...args); } finally { activeAsync--; }
  };
  syncBuiltinESMExports();
  try { await fn(); } finally {
    for (const name of methods) fs[name] = original[name];
    for (const name of asyncMethods) fs.promises[name] = originalAsync[name];
    syncBuiltinESMExports();
  }
  return { ...counts, readdir_unique: directories.size,
    readdir_repeated: [...directories.values()].filter((count) => count > 1).length,
    async: { ...asyncCounts, max_active: maxActiveAsync } };
}
function within(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes benchmark root: ${path}`);
  return target;
}
async function loadBuild(label, dist) {
  const load = (path) => import(pathToFileURL(join(dist, path)).href);
  const paths = ["loader/index.js", "remote/github.js", "tools/read-skill.js", "openai/mentions.js"];
  const moduleSha256 = Object.fromEntries(paths.map((path) => [path,
    createHash("sha256").update(fs.readFileSync(join(dist, path))).digest("hex")]));
  const [loader, remote, tool, mentions] = await Promise.all([
    load("loader/index.js"), load("remote/github.js"), load("tools/read-skill.js"), load("openai/mentions.js"),
  ]);
  report.builds.push({ label, dist, module_sha256: moduleSha256 });
  return { label, ...loader, ...remote, ...tool, ...mentions };
}
function seedFixture(entry, catalog, sourceDir, remoteRoot) {
  const remoteDir = within(remoteRoot, entry.relative_path);
  for (const file of catalog.files) {
    if (!["100644", "100755"].includes(file.mode)) {
      throw new Error(`Fixture supports regular files only: ${entry.name}/${file.path} (mode ${file.mode})`);
    }
    const target = within(remoteDir, file.path);
    fs.mkdirSync(dirname(target), { recursive: true });
    if (basename(file.path) === "SKILL.md") {
      const data = fs.readFileSync(within(sourceDir, file.path));
      if (data.length !== file.size) throw new Error(`Source differs from catalog: ${entry.name}/${file.path}`);
      fs.writeFileSync(target, data);
    } else {
      const fd = fs.openSync(target, "w");
      try { fs.ftruncateSync(fd, file.size); } finally { fs.closeSync(fd); }
    }
    fs.chmodSync(target, file.mode === "100755" ? 0o755 : 0o644);
  }
  fs.writeFileSync(join(remoteDir, ".codex-skills.tree.json"), JSON.stringify({
    version: 1, files: catalog.files, completedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
    source: { repo: "benchmark/fixture", branch: "main", path: "skills" }, fileIndexSha256: entry.file_index.sha256,
  }));
  return remoteDir;
}
function handlers(build, cfg, loader, entry) {
  const engine = { findByName: (name) => name === entry.name ? entry : undefined,
    defaultSuggestions: () => [entry], getButlerEntry: () => undefined };
  let tool;
  build.registerReadSkill({ tool: (...args) => { tool = args.at(-1); } }, engine, loader);
  const resources = new Map();
  build.registerOpenAIMentions({ registerResource: (name, ...args) => resources.set(name, args.at(-1)) },
    { mentions: { setHandler() {} } }, cfg, engine, loader);
  const extra = { signal: new AbortController().signal };
  return {
    tool_read_skill: () => tool({ name: entry.name }, extra),
    app_resource_preview: () => resources.get("skill")(new URL(`skill://${encodeURIComponent(entry.name)}`),
      { name: encodeURIComponent(entry.name) }, extra),
  };
}
async function inspect(entry, builds, index) {
  if (!entry.file_index) throw new Error(`Skill has no file catalog: ${entry.name}`);
  const catalogData = fs.readFileSync(within(sourceRoot, entry.file_index.path));
  if (createHash("sha256").update(catalogData).digest("hex") !== entry.file_index.sha256) {
    throw new Error(`Source catalog does not match manifest digest: ${entry.name}`);
  }
  const catalog = JSON.parse(catalogData);
  const sourceDir = within(sourceRoot, entry.relative_path);
  const remoteRoot = join(scratch, String(index));
  const remoteDir = seedFixture(entry, catalog, sourceDir, remoteRoot);
  const item = { name: entry.name, files: catalog.files.length, total_bytes: entry.file_index.total_bytes,
    catalog_bytes: catalogData.length, root_skill_bytes: fs.statSync(join(sourceDir, "SKILL.md")).size,
    nested_skills: catalog.files.filter((file) => file.path !== "SKILL.md" && basename(file.path) === "SKILL.md").length,
    builds: {} };
  for (const build of builds) {
    const local = new build.SkillLoader(config(sourceRoot, false), [entry]);
    const cfg = config(remoteRoot, true);
    const remote = new build.SkillLoader(cfg, [entry]);
    const localOperations = {
      scanDirectory: () => local.scanDirectory(sourceDir, 0, 2),
      findSubSkills: () => { const found = []; local.findSubSkills(sourceDir, sourceDir, found); return found; },
      scanStructure: () => local.scanStructure(sourceDir, entry),
      cacheState: () => local.cacheState(entry),
      readSkill: () => local.readSkill(entry),
      ...(typeof local.readInstructions === "function" ? { readInstructions: () => local.readInstructions(entry) } : {}),
      skillMdOnly: () => fs.readFileSync(join(sourceDir, "SKILL.md"), "utf8"),
    };
    const remoteOperations = {
      ensureSkillFetched: () => build.ensureSkillFetched(cfg, entry),
      scanStructure: () => remote.scanStructure(remoteDir, entry),
      cacheState: () => remote.cacheState(entry),
      readSkill: () => remote.readSkill(entry),
      ...(typeof remote.readInstructions === "function" ? { readInstructions: () => remote.readInstructions(entry) } : {}),
      ...handlers(build, cfg, remote, entry),
      fresh_tool_read_skill: () => handlers(build, cfg, new build.SkillLoader(cfg, [entry]), entry).tool_read_skill(),
    };
    const result = { local_source: {}, remote_fixture: {} };
    for (const [scope, operations] of [["local_source", localOperations], ["remote_fixture", remoteOperations]]) {
      for (const [operation, fn] of Object.entries(operations)) {
        result[scope][operation] = { ...await measure(fn), io: await countIO(fn) };
      }
    }
    for (const operation of ["tool_read_skill", "fresh_tool_read_skill", "app_resource_preview"]) {
      const start = performance.now();
      const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - start), 0));
      await remoteOperations[operation]();
      result.remote_fixture[operation].event_loop_timer_delay_ms = round(await timer);
      const concurrentStart = performance.now();
      await Promise.all(Array.from({ length: 4 }, () => remoteOperations[operation]()));
      result.remote_fixture[operation].concurrent_4_wall_ms = round(performance.now() - concurrentStart);
    }
    result.remote_fixture.complete = remote.cacheState(entry).complete;
    if (!result.remote_fixture.complete) throw new Error(`Incomplete fixture after ${build.label}: ${entry.name}`);
    item.builds[build.label] = result;
    savedError(`Measured ${build.label}: ${entry.name} (${catalog.files.length} files)`);
  }
  if (item.builds.baseline) {
    item.comparison = Object.fromEntries(["tool_read_skill", "fresh_tool_read_skill", "app_resource_preview"].map((operation) => {
      const before = item.builds.baseline.remote_fixture[operation].p50_ms;
      const after = item.builds.current.remote_fixture[operation].p50_ms;
      return [operation, { baseline_p50_ms: before, current_p50_ms: after,
        reduction_percent: round((1 - after / before) * 100), speedup: round(before / after) }];
    }));
  }
  report.skills.push(item);
}
try {
  const builds = [];
  if (values["baseline-dist"]) builds.push(await loadBuild("baseline", resolve(values["baseline-dist"])));
  builds.push(await loadBuild("current", currentDist));
  for (const [index, name] of names.entries()) {
    const entry = manifest.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`Skill not found in source manifest: ${name}`);
    await inspect(entry, builds, index);
  }
  report.network_requests = networkRequests;
  report.completed_at = new Date().toISOString();
  if (networkRequests !== 0) throw new Error(`Offline benchmark attempted ${networkRequests} network requests`);
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) fs.writeFileSync(resolve(values.output), json);
  process.stdout.write(json);
} finally {
  globalThis.fetch = savedFetch;
  console.error = savedError;
  fs.rmSync(scratch, { recursive: true, force: true });
}
