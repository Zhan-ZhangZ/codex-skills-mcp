import assert from "node:assert/strict";
import test from "node:test";
import { SkillSearchEngine } from "../dist/search/index.js";

const entry = (name, description, extra = {}) => ({
  name,
  description,
  category: "test",
  folder: name,
  relative_path: `./${name}`,
  ...extra,
});

const manifest = [
  entry("ppt-skill", "PPT presentation 幻灯片 制作 汇报"),
  entry("email-polish", "Email draft 汇报 邮件 润色"),
  entry("financial-api", "Financial API 同花顺 财务报表"),
  entry("legal-parse", "Legal contract parser 合同 法律 条款"),
  entry("video-translate", "Video translation 视频翻译 字幕 配音"),
  entry("video-edit", "Video editing 视频剪辑 字幕 特效"),
];

test("mixed CJK and Latin task text keeps the Latin deliverable", () => {
  const engine = new SkillSearchEngine(manifest);
  const keyword = engine.searchWithTotal("季度汇报PPT", { mode: "keyword" });
  assert.equal(keyword.results[0]?.name, "ppt-skill");
  assert.ok(keyword.results[0].match_reasons?.includes("关键词「ppt」"));
});

test("multi-character keyword queries reject single-character noise", () => {
  const engine = new SkillSearchEngine(manifest);
  const page = engine.searchWithTotal("合同", { mode: "keyword" });
  assert.deepEqual(page.results.map((item) => item.name), ["legal-parse"]);
  assert.ok(page.results[0].match_reasons?.includes("关键词「合同」"));
});

test("task mode extracts deliverables, merges candidates and explains confidence", () => {
  const engine = new SkillSearchEngine(manifest);
  const ppt = engine.searchWithTotal("老板让我做个季度汇报PPT", { mode: "task" });
  assert.equal(ppt.results[0]?.name, "ppt-skill");
  assert.equal(ppt.results[0]?.match_mode, "task");
  assert.equal(ppt.results[0]?.confidence_label, "high");
  assert.ok(ppt.results[0].match_reasons?.some((reason) => reason.includes("交付物")));

  const video = engine.searchWithTotal("把视频翻译成中文字幕", { mode: "task" });
  assert.equal(video.results[0]?.name, "video-translate");
  assert.ok(video.results[0].match_reasons?.some((reason) => reason.includes("视频翻译")));
});

test("keyword mode remains available for known-item lookup", () => {
  const engine = new SkillSearchEngine(manifest);
  const page = engine.searchWithTotal("PPT", { mode: "keyword" });
  assert.equal(page.results[0]?.name, "ppt-skill");
  assert.equal(page.results[0]?.match_mode, "keyword");
  assert.notEqual(page.results[0]?.confidence_label, "low");
});
