#!/usr/bin/env node
/**
 * Deterministic, offline search benchmark. No pass/fail latency thresholds.
 *   node scripts/benchmark-search.mjs
 *   node scripts/benchmark-search.mjs --module /path/to/baseline-search.mjs
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--module" || !args[1])) {
  console.error("Usage: node scripts/benchmark-search.mjs [--module SEARCH_MODULE]");
  process.exit(1);
}
const moduleUrl = args[1]
  ? (args[1].startsWith("file:") ? new URL(args[1]) : pathToFileURL(resolve(args[1])))
  : new URL("../dist/search/index.js", import.meta.url);
const { SkillSearchEngine } = await import(moduleUrl.href);
if (typeof SkillSearchEngine !== "function") throw new Error("Module must export SkillSearchEngine");

const domains = [
  ["frontend-performance", "React TypeScript browser profiling latency rendering", "前端性能 页面渲染 组件分析", ["react", "frontend"]],
  ["academic-research", "academic literature paper search citation review", "学术论文 文献检索 引用核查", ["papers", "scholar"]],
  ["data-visualization", "data charts plots dashboard statistical visualization", "数据分析 图表可视化 统计报表", ["datavisualization", "charts"]],
  ["backend-api", "backend REST API database query authentication", "后端接口 数据库查询 服务认证", ["backend", "database"]],
  ["video-production", "video editing subtitles animation audio timeline", "视频剪辑 字幕转写 音频动画", ["video", "subtitles"]],
  ["document-writing", "document writing editing Word PDF report", "文档写作 编辑校对 报告排版", ["writing", "documents"]],
  ["software-testing", "software testing coverage unit integration browser", "软件测试 单元验证 集成测试", ["testing", "coverage"]],
  ["cloud-operations", "cloud Kubernetes deployment monitoring observability", "云端部署 容器编排 运行监控", ["kubernetes", "cloud"]],
  ["security-analysis", "security audit vulnerability threat model protocols", "安全审计 漏洞分析 协议检查", ["security", "audit"]],
  ["design-assets", "design typography illustration icons color layout", "视觉设计 字体插画 图标排版", ["design", "illustration"]],
  ["spreadsheet-modeling", "spreadsheet Excel financial formula calculation", "电子表格 财务建模 公式计算", ["spreadsheets", "excel"]],
  ["workflow-automation", "workflow automation agents scheduling orchestration", "工作流程 自动执行 任务编排", ["workflow", "automation"]],
];

// Exactly 240 stable bilingual fixtures; no repository/user manifest is read.
const manifest = domains.flatMap(([slug, english, chinese, aliases], domain) =>
  Array.from({ length: 20 }, (_, variant) => {
    const id = String(variant).padStart(2, "0");
    return {
      name: `${slug}-${id}`,
      description: `${english}. ${chinese}。Variant ${id}: plan, inspect, implement and verify repeatable project outputs. Leading Words: ${english.split(" ").slice(0, 3).join(", ")}, ${chinese.split(" ")[0]}`,
      category: `category-${String(domain).padStart(2, "0")}`,
      folder: `${slug}-${id}`,
      relative_path: `./category-${domain}/${slug}-${id}`,
      aliases: [...aliases],
      tags: [...english.split(" ").slice(0, 3), ...chinese.split(" ")],
      language: variant % 2 ? "en" : "zh",
    };
  })
);
const queries = [
  { kind: "exact-name", query: "frontend-performance-07" },
  { kind: "english-task", query: "Analyze React browser rendering performance and database latency then create a verified testing report" },
  { kind: "chinese-task", query: "学术论文 文献检索 参考文献 引用核查" },
  { kind: "mixed-language", query: "TypeScript 前端性能 browser 集成测试" },
  { kind: "typo-fuzzy", query: "datavizualization" },
  { kind: "no-match", query: "qzxvplmnunknownkey" },
];

const round = (value) => Number(value.toFixed(4));
function statistics(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    mean_ms: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

const buildTimes = [];
let engine;
for (let iteration = 0; iteration < 25; iteration++) {
  const start = performance.now();
  engine = new SkillSearchEngine(manifest);
  buildTimes.push(performance.now() - start);
}
for (let iteration = 0; iteration < 50; iteration++) {
  for (const { query } of queries) engine.search(query, { limit: 8 });
}

const samplesPerQuery = 250;
const timings = queries.map(() => []);
for (let iteration = 0; iteration < samplesPerQuery; iteration++) {
  for (let offset = 0; offset < queries.length; offset++) {
    const index = (iteration + offset) % queries.length;
    const start = performance.now();
    engine.search(queries[index].query, { limit: 8 });
    timings[index].push(performance.now() - start);
  }
}

console.log(JSON.stringify({
  module: moduleUrl.href,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  fixture_skills: manifest.length,
  samples_per_query: samplesPerQuery,
  warmup_rounds: 50,
  index: { cold_ms: round(buildTimes[0]), samples: buildTimes.length, ...statistics(buildTimes) },
  search: { samples: timings.flat().length, ...statistics(timings.flat()) },
  queries: queries.map((definition, index) => {
    const results = engine.search(definition.query, { limit: 8 });
    return { ...definition, ...statistics(timings[index]), result_count: results.length, top_result: results[0]?.name ?? null };
  }),
}, null, 2));
