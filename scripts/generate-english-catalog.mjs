#!/usr/bin/env node
/**
 * Generate a checked-in English presentation catalog for the current skill
 * manifest. This is a maintainer helper, not part of the production build.
 *
 * Usage:
 *   node scripts/generate-english-catalog.mjs \
 *     [--input ~/.codex-skills-cache/skills_manifest.json] \
 *     [--output app-src/catalog-en.json]
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as wait } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  input: { type: "string", default: resolve(homedir(), ".codex-skills-cache/skills_manifest.json") },
  output: { type: "string", default: resolve(root, "app-src/catalog-en.json") },
} });
const inputPath = resolve(values.input);
const outputPath = resolve(values.output);
const raw = await readFile(inputPath, "utf8");
const manifest = JSON.parse(raw);
if (!Array.isArray(manifest)) throw new Error("Manifest must be an array");

const BOUNDARY = "<<<CODEX_SKILLS_BOUNDARY>>>";
const MAX_BATCH_CHARS = 3_500;
const MAX_BATCH_ITEMS = 12;
const HAN_RE = /[\u3400-\u9fff]/;
const CATEGORY_OVERRIDES = new Map([
  ["00_全局大管家", "00 · Global Router"],
  ["01_代码工程与架构", "01 · Code Engineering & Architecture"],
  ["02_DevOps与自动化", "02 · DevOps & Automation"],
  ["03_效率工具与协同管理", "03 · Productivity & Collaboration"],
  ["04_内容创作与文档处理", "04 · Content & Document Workflows"],
  ["05_多媒体与设计资产", "05 · Media & Design Assets"],
  ["06_商业与专业领域", "06 · Business & Professional"],
  ["07_智能体框架与协同", "07 · Agent Frameworks & Orchestration"],
  ["08_MCP服务开发与评估", "08 · MCP Development & Evaluation"],
  ["09_Composio集成服务", "09 · Composio Integrations"],
  ["10_Skill开发脚手架与安装器", "10 · Skill Scaffolding & Installers"],
  ["11_API与第三方应用集成", "11 · APIs & Third-Party Integrations"],
  ["12_学术论文与科研图表", "12 · Academic Research & Scientific Figures"],
  ["13_社科研究与实证工具", "13 · Social Science & Empirical Tools"],
  ["14_股票币圈财经专项", "14 · Markets & Crypto Finance"],
  ["15_优质GitHub项目清单", "15 · Curated GitHub Projects"],
  ["16_专业设计与生产交付", "16 · Professional Design & Production Delivery"],
  ["17_国内外电商工作流", "17 · E-commerce Workflows"],
  ["18_工程电子领域", "18 · Engineering & Electronics"],
]);

function batches(items) {
  const result = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const size = item.text.length + BOUNDARY.length + 2;
    if (current.length && (current.length >= MAX_BATCH_ITEMS || chars + size > MAX_BATCH_CHARS)) {
      result.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length) result.push(current);
  return result;
}

async function translateBatch(batch) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const body = new URLSearchParams({
        client: "gtx",
        sl: "zh-CN",
        tl: "en",
        dt: "t",
        q: batch.map((item) => item.text).join(`\n${BOUNDARY}\n`),
      });
      const response = await fetch("https://translate.googleapis.com/translate_a/single", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
      });
      if (!response.ok) throw new Error(`translation HTTP ${response.status}`);
      const data = await response.json();
      const translated = Array.isArray(data?.[0])
        ? data[0].map((part) => Array.isArray(part) ? String(part[0] ?? "") : "").join("")
        : "";
      const parts = translated.split(BOUNDARY).map((part) => part.trim());
      if (parts.length !== batch.length) {
        throw new Error(`translation boundary mismatch: expected ${batch.length}, got ${parts.length}`);
      }
      return parts;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(500 * (attempt + 1));
    }
  }
  throw lastError;
}

const categoryNames = [...new Set(manifest
  .map((entry) => typeof entry?.category === "string" ? entry.category.trim() : "")
  .filter(Boolean))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const skillDescriptions = manifest
  .map((entry) => ({
    name: typeof entry?.name === "string" ? entry.name : "",
    text: typeof entry?.description === "string" ? entry.description.trim() : "",
  }))
  .filter((entry) => entry.name && entry.text && HAN_RE.test(entry.text));

const categoryTranslations = new Map();
const descriptionTranslations = new Map();
for (const batch of batches([
  ...categoryNames.map((category) => ({ kind: "category", key: category, text: category })),
  ...skillDescriptions.map((entry) => ({ kind: "skill", key: entry.name, text: entry.text })),
])) {
  const translations = await translateBatch(batch);
  batch.forEach((item, index) => {
    const target = item.kind === "category" ? categoryTranslations : descriptionTranslations;
    target.set(item.key, translations[index]);
  });
  process.stderr.write(`[catalog-en] translated ${batch.length} entries\n`);
}

const categories = Object.fromEntries(categoryNames.map((category) => [
  category,
  CATEGORY_OVERRIDES.get(category) ?? categoryTranslations.get(category) ?? category,
]));
const skills = Object.fromEntries(skillDescriptions.map((entry) => [
  entry.name,
  {
    source: entry.text,
    description: descriptionTranslations.get(entry.name) ?? entry.text,
  },
]));
const output = {
  version: 1,
  manifest_sha256: createHash("sha256").update(raw).digest("hex"),
  categories,
  skills,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`${outputPath}: ${categoryNames.length} categories, ${skillDescriptions.length} descriptions`);
