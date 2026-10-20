import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLoader } from "../dist/loader/index.js";
import { registerReadSkill } from "../dist/tools/read-skill.js";
import { registerListSkillFiles } from "../dist/tools/list-skill-files.js";

const entry = { name: "navigation-demo", description: "fixture", category: "test", folder: "demo", relative_path: "./demo" };

function handlers() {
  const registered = new Map();
  return {
    registered,
    tool: (name, ...args) => registered.set(name, args.at(-1)),
    call(name, args) { return registered.get(name)(args, { signal: new AbortController().signal }); },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "codex-tool-navigation-"));
  const skill = join(root, "demo");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(join(skill, "SKILL.md"), "# Complete root instructions\n\nROOT-BODY-UNIQUE");
  fs.writeFileSync(join(skill, "requirements.txt"), "requests\n");
  for (let i = 0; i < 73; i++) {
    const path = join(skill, `child-${String(i + 1).padStart(3, "0")}`);
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(join(path, "SKILL.md"), `---\nname: child ${i + 1}\ndescription: >-\n  folded child ${i + 1} summary with "quoted text"\n---\nbody name: not-this\n`);
    fs.writeFileSync(join(path, `data-${i}.txt`), `data ${i}\n`);
  }
  const config = { skillsDir: root, manifestPath: join(root, "skills_manifest.json"), isRemote: false,
    githubRepo: "fixture/navigation", githubBranch: "main", githubPath: "skills",
    useOfficialMirror: false, hedgeEnabled: false, downloadConcurrency: 3, downloadTimeout: 1_000,
    manifestTTL: 0, manifestPollMs: 0, softDeadlineMs: 0, hardDeadlineMs: 0 };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loader = new SkillLoader(config, [entry]);
  const engine = { findByName: (name) => name === entry.name ? entry : undefined };
  const tools = handlers();
  registerReadSkill(tools, engine, loader);
  registerListSkillFiles(tools, engine, loader);
  return { config, skill, loader, tools };
}

test("read_skill emits bounded previews whose cursors continue in list_skill_files", async (t) => {
  const { tools } = fixture(t);
  const read = await tools.call("read_skill", { name: entry.name });
  assert.equal(read.isError, undefined);
  const readText = read.content[0].text;
  assert.match(readText, /ROOT-BODY-UNIQUE/);
  assert.equal(readText.split("ROOT-BODY-UNIQUE").length - 1, 1, "root instructions are not repeated by navigation");
  assert.match(readText, /\*\*child 1\*\* \(child-001\): folded child 1 summary with "quoted text"/);
  assert.equal(read.structuredContent.navigation.files.total, 221);
  assert.equal(read.structuredContent.navigation.sub_skills.total, 73);

  const fileCursor = read.structuredContent.navigation.files.next_cursor;
  const subCursor = read.structuredContent.navigation.sub_skills.next_cursor;
  assert.ok(fileCursor && subCursor);
  let files = await tools.call("list_skill_files", { skill_name: entry.name, cursor: fileCursor });
  let fileCursorValue = files.structuredContent.next_cursor;
  for (let page = 0; page < 5 && fileCursorValue; page++) {
    assert.equal(files.isError, undefined);
    assert.doesNotMatch(files.content[0].text, /ROOT-BODY-UNIQUE/);
    if (files.content[0].text.includes("child-073/data-72.txt")) break;
    files = await tools.call("list_skill_files", { skill_name: entry.name, cursor: fileCursorValue });
    fileCursorValue = files.structuredContent.next_cursor;
  }
  assert.match(files.content[0].text, /child-073\/data-72\.txt/);
  assert.ok(files.structuredContent.offset > 0);
  assert.ok(files.structuredContent.entries.length > 0);
  assert.ok(files.structuredContent.entries.some((entry) => entry.path === "child-073/data-72.txt"));

  let skills = await tools.call("list_skill_files", { skill_name: entry.name, view: "sub_skills", cursor: subCursor, limit: 20 });
  let subCursorValue = skills.structuredContent.next_cursor;
  while (subCursorValue && !skills.content[0].text.includes("folded child 73 summary")) {
    assert.equal(skills.isError, undefined);
    skills = await tools.call("list_skill_files", { skill_name: entry.name, view: "sub_skills", cursor: subCursorValue, limit: 20 });
    subCursorValue = skills.structuredContent.next_cursor;
  }
  assert.match(skills.content[0].text, /folded child 73 summary/);
  assert.doesNotMatch(skills.content[0].text, /ROOT-BODY-UNIQUE/);
  assert.ok(skills.structuredContent.returned <= 20);
  assert.match(skills.structuredContent.entries.at(-1).description, /folded child/);
});

test("navigation cursors invalidate after a local file edit and text clients can query the last child", async (t) => {
  const { skill, tools } = fixture(t);
  const first = await tools.call("list_skill_files", { skill_name: entry.name, limit: 5 });
  const cursor = first.structuredContent.next_cursor;
  fs.writeFileSync(join(skill, "added.txt"), "new");
  const stale = await tools.call("list_skill_files", { skill_name: entry.name, cursor, limit: 5 });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /Invalid or expired navigation cursor/);

  const query = await tools.call("list_skill_files", { skill_name: entry.name, view: "sub_skills", query: "\"quoted text\" 073", limit: 2 });
  assert.equal(query.isError, undefined);
  assert.equal(query.structuredContent.matched, 1);
  assert.match(query.content[0].text, /child-073/);
  assert.equal(query.structuredContent.next_cursor, null);
});
