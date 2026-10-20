#!/usr/bin/env node
/**
 * Rebuild only generated top-level source-skill entrypoints.
 *
 * The source repository should preserve upstream SKILL.md files. This tool is
 * limited to short wrappers created during integration; --check is read-only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const { values } = parseArgs({ options: {
  "source-root": { type: "string", default: "/Users/zz/codexproject/codex-skills" },
  write: { type: "boolean" },
  "max-bytes": { type: "string", default: "700" },
  preview: { type: "string", default: "5" },
} });
const root = path.resolve(values["source-root"]);
const maxBytes = Number(values["max-bytes"]);
const previewCount = Number(values.preview);
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("--max-bytes must be a positive integer");
if (!Number.isSafeInteger(previewCount) || previewCount < 0) throw new Error("--preview must be a non-negative integer");

const manifest = JSON.parse(await fs.readFile(path.join(root, "skills_manifest.json"), "utf8"));
const legacyMarkers = [
  "## 集成说明（本库维护）",
  "See README.md for details.",
  "This is a skill wrapper for",
  "关于该技能的详细配置、触发提示词和执行命令",
  "## 安装与快速开始",
];
const managedMarker = "<!-- codex-skills-managed-entrypoint:v2 -->";
const skippedNestedDirectories = new Set([
  ".github",
  "benchmark",
  "benchmarks",
  "eval",
  "evals",
  "example",
  "examples",
  "fixture",
  "fixtures",
  "node_modules",
  "test",
  "tests",
]);
const KIND_OVERRIDES = {
  "Aletheore": "application",
  "Atomic-Chat": "application",
  "asm": "application",
  "claude-code-best-practice": "documentation",
  "claude-mem": "application",
  "codegraph": "application",
  "codex-plugin-cc": "application",
  "cortex": "application",
  "elevenlabs-cli": "application",
  "kicad-mcp-automation": "mcp",
  "lilbee": "application",
  "mcp-toolbox": "mcp",
  "modular-context-obsidian-plugin": "application",
  "Mole": "application",
  "open-design": "application",
  "openlive": "application",
  "OpenSpace": "application",
  "phoenix": "application",
  "ragflow": "application",
  "slop-guard": "application",
  "vanna": "application",
  "WrenAI": "application",
  "x-cmd": "application",
  "aiogram": "application",
  "aurakit": "application",
};

function splitDocument(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return { frontmatter: match?.[1] ?? "", body: match ? text.slice(match[0].length) : text };
}

function oneLine(value, limit = 600) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  let output = "";
  for (const character of text) {
    if (Buffer.byteLength(output + character) > limit - 1) break;
    output += character;
  }
  return output + "…";
}

function descriptionWithoutSEO(value) {
  return String(value ?? "").replace(/\s*Leading\s*Words?\s*:[\s\S]*$/i, "").trim();
}

async function nestedSkills(directory) {
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".catalog" || entry.name === ".git" || skippedNestedDirectories.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name === "SKILL.md") {
        const text = await fs.readFile(target, "utf8");
        const { frontmatter } = splitDocument(text);
        let data = {};
        try { data = parseYaml(frontmatter) ?? {}; } catch { /* use folder fallback */ }
        const skillPath = path.relative(directory, path.dirname(target)).split(path.sep).join("/");
        if (!skillPath) continue;
        results.push({
          name: oneLine(data.name || path.basename(skillPath), 120),
          path: skillPath,
          description: oneLine(data.description || "No description in nested frontmatter", 220),
        });
      }
    }
  }
  await walk(directory);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function classify(entry, body, nested) {
  if (nested.length > 0) return "router";
  if (KIND_OVERRIDES[entry.name]) return KIND_OVERRIDES[entry.name];
  const haystack = `${entry.name} ${entry.description} ${body}`.toLowerCase();
  if (/(^|[-_])mcp(?:[-_]|$)/.test(entry.name.toLowerCase())) return "mcp";
  if (/awesome|精选|技能清单|资源清单|资源目录|\bcatalog\b|\bcollection\b/.test(haystack)) return "catalog";
  if (/文档层|documentation-only|docs only/.test(body)) return "documentation";
  return "application";
}

function upstreamUrl(entry, body, frontmatterData) {
  const fromBody = body.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/)?.[0];
  if (fromBody) return fromBody.replace(/\.git$/, "");
  const recorded = frontmatterData?.metadata?.upstream;
  if (typeof recorded === "string" && recorded.trim()) {
    return recorded.startsWith("http") ? recorded : `https://${recorded}`;
  }
  return "";
}

async function existingFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const preferred = entries
    .filter((entry) => entry.isFile() && /^(README(?:[._-][A-Za-z0-9_-]+)?\.(?:md|mdx|txt)|QUICKSTART(?:[._-][A-Za-z0-9_-]+)?\.(?:md|mdx|txt)|INSTALL(?:ATION)?(?:[._-][A-Za-z0-9_-]+)?\.(?:md|mdx|txt)|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|setup\.py|requirements\.txt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const priority = (name) => name === "README.md" ? 0 : name.startsWith("README") ? 1 : name === "QUICKSTART.md" ? 2 : 3;
      return priority(a) - priority(b) || a.localeCompare(b);
    })
    .slice(0, 6);
  if (entries.some((entry) => entry.isDirectory() && entry.name === "docs")) preferred.push("docs/");
  return preferred;
}

function deduplicateNested(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.name}\0${item.description}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const unique = [...groups.values()].map((list) => list.sort((a, b) => {
    const score = (item) => item.path.startsWith("skills/") ? 0 : item.path.startsWith(".") ? 2 : 1;
    return score(a) - score(b) || a.path.length - b.path.length || a.path.localeCompare(b.path);
  })[0]);
  const canonical = unique.filter((item) => !item.path.startsWith("."));
  // Platform mirrors such as .claude/.codex/.cursor duplicate the canonical
  // skills tree. Keep hidden-only scopes, but hide mirrors when canonical
  // entries exist.
  return canonical.length ? canonical : unique;
}

function buildBody(entry, context) {
  const description = descriptionWithoutSEO(entry.description);
  const terms = [...(entry.aliases ?? []), ...(entry.tags ?? [])].filter(Boolean).slice(0, 12);
  const lines = [
    managedMarker,
    `# ${entry.name}`,
    "",
    description,
    "",
    "## 何时使用",
    "",
    `适用任务：${description}`,
  ];
  if (terms.length) lines.push(`相关检索词：${terms.join("、")}。`);
  lines.push("", "先从下面列出的本地入口确认当前版本和真实用法；不要把包名当成已经安装、授权或验证过的能力。", "");

  if (context.kind === "router") {
    lines.push(
      "## 选择子技能",
      "",
      "先读取 `README.md` 的路由或目录说明，选择范围最窄且直接解决当前任务的嵌套技能，再读取它的 `SKILL.md`。只有任务确实跨多个阶段时才组合多个子技能。不要一次加载全部子技能。",
      "",
    );
    if (context.nested.length <= 24) {
      lines.push("当前可直接发现的子技能：", "");
      for (const nested of context.nested) {
        lines.push(`- \`${nested.path}/SKILL.md\` — **${nested.name}**：${nested.description}`);
      }
    } else {
      lines.push(
        `当前包内有 ${context.nested.length} 个嵌套技能。优先按 README 路由；需要全库查找时，使用当前环境的文件搜索工具检索嵌套 \`SKILL.md\` 的 frontmatter，再打开命中项，不要逐份读取整个目录。`,
      );
    }
    lines.push(
      "",
      "## 执行",
      "",
      "以选中的子技能说明为执行契约，并从本包根目录解析它引用的脚本、模板和参考资料。若 README 与子技能说明冲突，优先采用版本更新、离目标文件更近且能实际验证的那一份，并把冲突告诉用户。",
    );
  } else {
    lines.push("## 执行", "", "1. 读取与本任务直接相关的 README、安装说明和入口文件，确认所需运行时、权限与配置。");
    if (context.kind === "mcp") {
      lines.push(
        "2. 按仓库当前文档启动或接入 MCP 服务，核对实际工具名和参数；不要凭项目简介编造工具。",
        "3. 先用一个只读、最小请求验证连接，再执行用户要求的操作。凭据只从环境或安全配置读取，不写进技能文件。",
      );
    } else if (context.kind === "catalog") {
      lines.push(
        "2. 把 README 当作资源目录，而不是已安装技能清单。选定条目后核对它自己的仓库、许可证和说明。",
        "3. 只引入当前任务需要的条目，并验证其版本和可用性。",
      );
    } else if (context.kind === "documentation") {
      lines.push(
        "2. 把本包视为上游项目的文档快照；确认本地实际可用的产品或代码版本，不假设 README 描述的功能已经部署。",
        "3. 需要执行操作时，找到对应产品入口或回到上游仓库使用当前版本。",
      );
    } else {
      lines.push(
        "2. 从包管理文件和入口代码确认安装、构建、启动命令；优先运行仓库自带脚本，不自行替换成相近工具。",
        "3. 完成任务后运行该仓库提供的测试、校验或最小可观察流程，并报告未满足的环境条件。",
      );
    }
  }

  lines.push("", "## 本地入口", "");
  if (context.files.length) {
    lines.push(...context.files.map((file) => `- \`${file}\``));
  } else {
    lines.push("- 包内没有标准 README；先查看顶层文件和入口代码，确认实际用途后再操作。");
  }
  if (context.upstream) {
    lines.push("", "## 上游", "", `- ${context.upstream}`, "- 如需核对最新行为，以上游仓库和本地固定版本的差异为准。");
  }
  lines.push(
    "",
    "## 完成标准",
    "",
    "交付用户要求的结果，并说明实际运行的命令、验证方式、仍需配置的凭据或未能验证的边界。",
    "",
  );
  return lines.join("\n");
}

const changes = [];
for (const entry of manifest) {
  const directory = path.join(root, entry.relative_path.replace(/^\.\//, ""));
  const file = path.join(directory, "SKILL.md");
  const text = await fs.readFile(file, "utf8");
  // A managed-v2 entrypoint has already been reviewed or generated once.
  // Never rewrite it automatically: later edits may be manual corrections.
  if (text.includes(managedMarker)) continue;
  const { frontmatter, body } = splitDocument(text);
  const bodyBytes = Buffer.byteLength(body);
  const markedGenerated = legacyMarkers.some((marker) => body.includes(marker));
  // Author-owned SKILL.md files are never replaced. Only short legacy wrappers
  // created by this maintenance tool are eligible for migration.
  if (!markedGenerated) continue;
  if (bodyBytes > maxBytes && bodyBytes > 2500) continue;
  let data = {};
  try { data = parseYaml(frontmatter) ?? {}; } catch { /* replace malformed frontmatter */ }
  const nested = deduplicateNested(await nestedSkills(directory));
  const recordedKind = data?.metadata?.entrypoint_kind;
  const kind = KIND_OVERRIDES[entry.name] ??
    (["router", "mcp", "catalog", "documentation", "application"].includes(recordedKind)
      ? recordedKind : classify(entry, body, nested));
  const context = {
    kind,
    nested,
    files: await existingFiles(directory),
    upstream: upstreamUrl(entry, body, data),
  };
  const metadata = { ...(data.metadata ?? {}) };
  if (context.upstream && !metadata.upstream) metadata.upstream = context.upstream.replace(/^https?:\/\//, "");
  metadata.entrypoint = "managed-v2";
  metadata.entrypoint_kind = context.kind;
  const nextFrontmatter = stringifyYaml({ ...data, name: entry.name, description: entry.description, metadata }).trimEnd();
  const next = `---\n${nextFrontmatter}\n---\n\n${buildBody(entry, context)}`;
  changes.push({ entry, file, old: text, next, kind, nested: nested.length, bodyBytes });
}

const counts = changes.reduce((result, change) => {
  result[change.kind] = (result[change.kind] ?? 0) + 1;
  return result;
}, {});
console.log(JSON.stringify({ source_root: root, mode: values.write ? "write" : "check", changes: changes.length, counts }, null, 2));
for (const change of changes.slice(0, previewCount)) {
  console.log(`\n===== ${change.entry.name} (${change.kind}, ${change.nested} nested) =====\n${change.next}`);
}
if (values.write) {
  for (const change of changes) {
    const temporary = change.file + ".codex-entrypoint.tmp";
    await fs.writeFile(temporary, change.next, "utf8");
    await fs.rename(temporary, change.file);
  }
  console.log(`\nWrote ${changes.length} managed entrypoints.`);
}
