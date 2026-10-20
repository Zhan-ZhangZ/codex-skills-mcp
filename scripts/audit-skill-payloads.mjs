#!/usr/bin/env node
/** Read-only source/catalog/payload audit. No credentials, materialization or network.
 * node scripts/audit-skill-payloads.mjs --source-root SOURCE --dist BUILD/dist --output REPORT.json
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const { values } = parseArgs({ options: {
  "source-root": { type: "string" }, dist: { type: "string" }, output: { type: "string" }, help: { type: "boolean", short: "h" },
  "validate-yaml": { type: "boolean" },
  full: { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
} });
if (values.help || !values["source-root"]) {
  console.log("Usage: node scripts/audit-skill-payloads.mjs --source-root SOURCE [--dist DIST] [--output JSON] [--validate-yaml] [--full] [--verbose]");
  console.log("Optional --validate-yaml requires python3 with PyYAML; it validates root frontmatter using safe_load.");
  process.exit(values.help ? 0 : 1);
}
const root = await fs.realpath(resolve(values["source-root"]));
const dist = resolve(values.dist ?? fileURLToPath(new URL("../dist", import.meta.url)));
const digest = (data) => createHash("sha256").update(data).digest("hex");
const bytes = (text) => Buffer.byteLength(text);
const gitBlob = (data) => createHash("sha1").update("blob " + data.length + "\0").update(data).digest("hex");
const round = (number) => Math.round(number * 100) / 100;
const contained = (base, target) => { const rel = relative(base, target); return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); };
async function sourcePath(base, requested) {
  const target = resolve(base, requested);
  if (!contained(base, target)) throw new Error("Source path escapes its root: " + requested);
  const canonical = await fs.realpath(target);
  if (!contained(root, canonical)) throw new Error("Source symlink escapes checkout: " + requested);
  return canonical;
}
const manifestBytes = await fs.readFile(join(root, "skills_manifest.json"));
const manifest = JSON.parse(manifestBytes);
const { SkillLoader } = await import(pathToFileURL(join(dist, "loader/index.js")).href);
const { registerReadSkill } = await import(pathToFileURL(join(dist, "tools/read-skill.js")).href);
const { registerOpenAIMentions } = await import(pathToFileURL(join(dist, "openai/mentions.js")).href);
const config = { skillsDir: root, manifestPath: join(root, "skills_manifest.json"), isRemote: false,
  githubPath: "skills", useOfficialMirror: false, hedgeEnabled: false, softDeadlineMs: 0, hardDeadlineMs: 0,
  downloadConcurrency: 8, downloadTimeout: 1000, manifestTTL: 0, manifestPollMs: 0 };
const loader = new SkillLoader(config, manifest);
if (typeof loader.catalogStructure !== "function") throw new Error("Audit needs the catalogStructure loader build");
const savedError = console.error;
const savedFetch = globalThis.fetch;
let networkRequests = 0;
console.error = () => {};
globalThis.fetch = async () => { networkRequests++; throw new Error("Audit is offline"); };
const report = {
  started_at: new Date().toISOString(), source_root: root, dist, manifest_sha256: digest(manifestBytes),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  build_sha256: Object.fromEntries(await Promise.all(["loader/index.js", "tools/read-skill.js", "openai/mentions.js"].map(async (path) =>
    [path, digest(await fs.readFile(join(dist, path)))]))),
  notes: [
    "All source access is read-only. Catalog digests and root SKILL.md Git blob SHA/size are checked; other supporting file bodies are not all reread.",
    "Payloads use the actual built tool formatter with catalog-driven structures. Synthetic complete cache metadata uses the source path; overhead differs slightly from real cache paths/timestamps.",
    "The root router uses its actual resource handler and is excluded from ordinary skill-tool aggregates.",
    "Byte shares are UTF-8 text bytes; chars are JavaScript UTF-16 code units, matching existing UI truncation. No tokenizer estimates are asserted.",
    "Frontmatter extraction handles top-level scalar strings/block scalars for comparison, not arbitrary YAML. Mismatches are review candidates.",
    "Size thresholds and marketing-language matches identify review candidates, not automatic quality failures.",
  ], entries: [], issues: [],
};
const issue = (name, code, detail) => report.issues.push({ name, code, detail });
const textExtensions = new Set([".md", ".txt", ".rst", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".xml", ".html", ".ipynb", ".tex", ".log"]);
const documentFiles = [];
const rootHashes = new Map();

function unquote(value) {
  if (value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34) { try { return JSON.parse(value); } catch {} }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}
function frontmatter(text) {
  const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { present: false };
  const lines = match[1].split(/\r?\n/);
  const result = { present: true, chars: match[0].length };
  for (let i = 0; i < lines.length; i++) {
    const field = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!field) continue;
    const [, key, raw] = field;
    if (/^[>|][-+]?$/.test(raw)) {
      const parts = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1])) parts.push(lines[++i].trim());
      result[key] = parts.join(raw.startsWith(">") ? " " : "\n").trim();
    } else result[key] = unquote(raw.trim());
  }
  return result;
}
function rootDetails(text) {
  const lines = text.split("\n");
  const headings = [];
  let fence = null;
  let codeBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(\x60{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null; }
    else if (!fence && /^#{1,3} /.test(lines[i])) headings.push({ line: i + 1, text: lines[i] });
    if (fence || marker) codeBytes += bytes(lines[i] + "\n");
  }
  return { bytes: bytes(text), chars: text.length, lines: lines.length, code_fence_bytes: codeBytes,
    heading_count: headings.length, headings: headings.slice(0, 40), frontmatter: frontmatter(text),
    preview_12000_chars_truncated: text.length > 12000,
    pages_at_8000_chars: Math.ceil(text.length / 8000), pages_at_16000_chars: Math.ceil(text.length / 16000) };
}
function duplicates(items, key) {
  const groups = new Map();
  for (const item of items) { const value = key(item); if (value) groups.set(value, [...(groups.get(value) ?? []), item.name]); }
  return [...groups.entries()].filter(([, names]) => names.length > 1).map(([value, names]) => ({ value, names }));
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { min: sorted[0] ?? 0, p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), max: sorted.at(-1) ?? 0,
    sum: values.reduce((sum, value) => sum + value, 0) };
}
async function renderTool(entry, instructions, structure, dependencies, fileCount, totalBytes) {
  let handler;
  const result = { instructions, structure, dependencies, cache: { cached: true, complete: true, catalogCurrent: true,
    localPath: resolve(root, entry.relative_path), filesTotal: fileCount, filesMissing: [], sizeBytes: totalBytes } };
  registerReadSkill({ tool: (...args) => { handler = args.at(-1); } }, { findByName: () => entry },
    { downloadDeadlines: { softDeadlineMs: 0, hardDeadlineMs: 0 }, readSkill: async () => result });
  const response = await handler({ name: entry.name }, { signal: new AbortController().signal });
  if (response.isError) throw new Error(response.content[0].text);
  const text = response.content[0].text;
  const startMarker = "## Instructions\n\n";
  const instructionMarker = text.indexOf(startMarker);
  const instructionsStart = instructionMarker + startMarker.length;
  if (instructionMarker < 0 || text.slice(instructionsStart, instructionsStart + instructions.length) !== instructions) throw new Error("Tool instruction format changed");
  const fence = String.fromCharCode(96).repeat(3);
  const treeMarker = "## File Structure\n" + fence + "\n";
  const treeMarkerStart = text.indexOf(treeMarker, instructionsStart + instructions.length);
  const treeStart = treeMarkerStart + treeMarker.length;
  const treeEnd = text.indexOf("\n" + fence + "\n", treeStart);
  if (treeMarkerStart < 0 || treeEnd < treeStart) throw new Error("Tool tree format changed");
  const tree = text.slice(treeStart, treeEnd);
  let subskillText = "";
  if (structure.sub_skills.length) {
    const marker = "\n## Sub-Skills\n";
    const markerStart = text.indexOf(marker, treeEnd);
    const start = markerStart + marker.length;
    const end = text.indexOf("\n\nRead complete sub-skill instructions with load_skill_file(", start);
    if (markerStart < 0 || end < start) throw new Error("Tool subskill format changed");
    subskillText = text.slice(start, end);
  }
  const parts = { instructions_bytes: bytes(instructions), tree_bytes: bytes(tree), subskill_summary_bytes: bytes(subskillText) };
  parts.overhead_bytes = bytes(text) - Object.values(parts).reduce((sum, n) => sum + n, 0);
  return { text_bytes: bytes(text), chars: text.length, json_bytes: bytes(JSON.stringify(response)), ...parts,
    shares_percent: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key.replace("_bytes", ""), round(value / bytes(text) * 100)])),
    tree_lines: tree ? tree.split("\n").length : 0, subskills_returned: structure.sub_skills.length };
}

try {
  for (const [index, entry] of manifest.entries()) {
    const directory = await sourcePath(root, entry.relative_path);
    const instructionPath = await sourcePath(directory, "SKILL.md");
    const instructions = await fs.readFile(instructionPath, "utf8");
    const info = { name: entry.name, category: entry.category, folder: entry.folder, relative_path: entry.relative_path,
      metadata: { description: entry.description, description_chars: entry.description.length, description_bytes: bytes(entry.description),
        leading_words_chars: entry.description.match(/Leading\s*Words?\s*[:：].*$/i)?.[0].length ?? 0,
        aliases: entry.aliases ?? [], tags: entry.tags ?? [],
        marketing_terms: [...new Set(entry.description.match(/顶级|完美|一键|暴力|降维|彻底颠覆|最强|全能|无敌/g) ?? [])] },
      root: rootDetails(instructions) };
    for (const key of ["name", "description", "category", "folder"]) {
      if (!entry[key]?.trim()) issue(entry.name, "empty_metadata", key);
      if (entry[key] !== entry[key]?.trim()) issue(entry.name, "metadata_whitespace", key);
    }
    if (!info.root.frontmatter.present) issue(entry.name, "missing_frontmatter", "Root SKILL.md has no leading frontmatter");
    else {
      if (info.root.frontmatter.name !== entry.name) issue(entry.name, "frontmatter_name_mismatch", { manifest: entry.name, root: info.root.frontmatter.name ?? null });
      if (info.root.frontmatter.description !== entry.description) issue(entry.name, "frontmatter_description_mismatch", { manifest: entry.description, root: info.root.frontmatter.description ?? null });
    }
    const hash = digest(instructions);
    rootHashes.set(hash, [...(rootHashes.get(hash) ?? []), entry.name]);
    if (entry.relative_path === "./") {
      const resources = new Map();
      registerOpenAIMentions({ registerResource: (name, ...args) => resources.set(name, args.at(-1)) },
        { mentions: { setHandler() {} } }, config, { getButlerEntry: () => entry }, loader);
      const response = await resources.get("skill")(new URL("skill://" + encodeURIComponent(entry.name)), { name: entry.name }, { signal: new AbortController().signal });
      info.router_resource = { text_bytes: bytes(response.contents[0].text), chars: response.contents[0].text.length };
      report.entries.push(info);
      continue;
    }
    if (basename(directory) !== entry.folder) issue(entry.name, "folder_path_mismatch", { folder: entry.folder, basename: basename(directory) });
    if (basename(dirname(directory)) !== entry.category) issue(entry.name, "category_path_mismatch", { category: entry.category, parent: basename(dirname(directory)) });
    if (!entry.file_index) { issue(entry.name, "missing_catalog", null); report.entries.push(info); continue; }
    const catalogData = await fs.readFile(await sourcePath(root, entry.file_index.path));
    const catalog = JSON.parse(catalogData);
    const total = catalog.files.reduce((sum, file) => sum + file.size, 0);
    if (digest(catalogData) !== entry.file_index.sha256) issue(entry.name, "catalog_digest_mismatch", entry.file_index.path);
    if (catalog.files.length !== entry.file_index.file_count || total !== entry.file_index.total_bytes) issue(entry.name, "catalog_counts_mismatch", { files: catalog.files.length, bytes: total });
    if (catalog.skill_path.replace(/^\.\//, "") !== entry.relative_path.replace(/^\.\//, "")) issue(entry.name, "catalog_skill_path_mismatch", catalog.skill_path);
    const rootFile = catalog.files.find((file) => file.path === "SKILL.md");
    if (!rootFile) issue(entry.name, "root_missing_from_catalog", null);
    else if (rootFile.size !== bytes(instructions) || rootFile.sha !== gitBlob(Buffer.from(instructions))) issue(entry.name, "root_catalog_content_mismatch", rootFile);
    for (const file of catalog.files) {
      if (textExtensions.has(extname(file.path).toLowerCase()) && file.size > 500 * 1024) documentFiles.push({ skill: entry.name, path: file.path, bytes: file.size });
    }
    const structure = await loader.catalogStructure(directory, catalog.files, JSON.stringify([root, entry.relative_path, entry.file_index.sha256]));
    const nested = catalog.files.filter((file) => file.path !== "SKILL.md" && basename(file.path) === "SKILL.md");
    const returnedPaths = new Set(structure.sub_skills.map((skill) => skill.path.split(sep).join("/") + "/SKILL.md"));
    info.catalog = { files: catalog.files.length, bytes: total, catalog_bytes: catalogData.length, nested_skills: nested.length,
      omitted_nested_count: nested.filter((file) => !returnedPaths.has(file.path)).length,
      omitted_nested_examples: nested.filter((file) => !returnedPaths.has(file.path)).slice(0, 10).map((file) => file.path),
      text_documents_over_500k: documentFiles.filter((file) => file.skill === entry.name).length };
    const descriptions = structure.sub_skills.map((skill) => skill.description);
    info.subskills = { count: structure.sub_skills.length, description_chars: distribution(descriptions.map((text) => text.length)),
      empty_descriptions: descriptions.filter((text) => !text.trim()).length,
      yaml_block_marker_descriptions: descriptions.filter((text) => /^[>|][-+]?$/.test(text.trim())).length,
      quoted_descriptions: descriptions.filter((text) => /^(".*"|'.*')$/.test(text)).length,
      metadata_examples: await Promise.all([
        ["empty", (text) => !text.trim()],
        ["yaml_block_marker", (text) => /^[>|][-+]?$/.test(text.trim())],
        ["quoted", (text) => /^(".*"|'.*')$/.test(text)],
      ].flatMap(([kind, predicate]) => structure.sub_skills.filter((skill) => predicate(skill.description)).slice(0, 2).map(async (skill) => {
        const content = await fs.readFile(await sourcePath(directory, join(skill.path, "SKILL.md")), "utf8");
        const parsed = frontmatter(content);
        return { kind, name: skill.name, path: skill.path, displayed_description: skill.description,
          has_bom: content.startsWith("\uFEFF"), frontmatter_present: parsed.present,
          parsed_description_excerpt: parsed.description?.slice(0, 240) ?? null,
          source_first_lines: content.split(/\r?\n/).slice(0, 8) };
      }))),
      longest: [...structure.sub_skills].sort((a, b) => b.description.length - a.description.length).slice(0, 3).map((skill) =>
        ({ name: skill.name, path: skill.path, description_chars: skill.description.length, description_excerpt: skill.description.slice(0, 240) })),
      duplicate_names: duplicates(structure.sub_skills, (skill) => skill.name).slice(0, 20),
    };
    info.payload = await renderTool(entry, instructions, structure, loader.detectDependencies(directory), catalog.files.length, total);
    report.entries.push(info);
    if ((index + 1) % 25 === 0) savedError("Audited " + (index + 1) + "/" + manifest.length);
  }
  const regular = report.entries.filter((entry) => entry.payload);
  const totalPayload = regular.reduce((sum, entry) => sum + entry.payload.text_bytes, 0);
  const partTotals = Object.fromEntries(["instructions_bytes", "tree_bytes", "subskill_summary_bytes", "overhead_bytes"].map((key) =>
    [key, regular.reduce((sum, entry) => sum + entry.payload[key], 0)]));
  const descending = (field) => [...regular].sort((a, b) => field(b) - field(a));
  const largestPayload = descending((entry) => entry.payload.text_bytes)[0];
  const withoutLargest = regular.filter((entry) => entry.name !== largestPayload?.name);
  const withoutLargestBytes = withoutLargest.reduce((sum, entry) => sum + entry.payload.text_bytes, 0);
  const withoutLargestParts = Object.fromEntries(Object.keys(partTotals).map((key) =>
    [key, withoutLargest.reduce((sum, entry) => sum + entry.payload[key], 0)]));
  report.summary = { manifest_entries: manifest.length, catalog_entries: regular.length,
    catalog_files: regular.reduce((sum, entry) => sum + entry.catalog.files, 0),
    catalog_bytes: regular.reduce((sum, entry) => sum + entry.catalog.bytes, 0),
    categories: Object.fromEntries([...new Set(manifest.map((entry) => entry.category))].map((category) => [category, manifest.filter((entry) => entry.category === category).length])),
    alias_coverage: manifest.filter((entry) => entry.aliases?.length).length, tag_coverage: manifest.filter((entry) => entry.tags?.length).length,
    descriptions: distribution(manifest.map((entry) => entry.description.length)),
    description_over_160_chars: manifest.filter((entry) => entry.description.length > 160).length,
    leading_words_entries: report.entries.filter((entry) => entry.metadata.leading_words_chars > 0).length,
    leading_words_chars: report.entries.reduce((sum, entry) => sum + entry.metadata.leading_words_chars, 0),
    descriptions_without_leading_words_over_160_chars: manifest.filter((entry) =>
      entry.description.split(/Leading\s*Words?\s*[:：]/i)[0].trim().length > 160).length,
    marketing_terms_entries: report.entries.filter((entry) => entry.metadata.marketing_terms.length).length,
    exact_duplicate_names: duplicates(manifest, (entry) => entry.name),
    normalized_duplicate_names: duplicates(manifest, (entry) => entry.name.trim().normalize("NFKC").toLowerCase()),
    duplicate_paths: duplicates(manifest, (entry) => resolve(root, entry.relative_path)),
    duplicate_descriptions: duplicates(manifest, (entry) => entry.description),
    duplicate_root_instructions: [...rootHashes.entries()].filter(([, names]) => names.length > 1).map(([sha256, names]) => ({ sha256, names })),
    root_bytes: distribution(report.entries.map((entry) => entry.root.bytes)), root_chars: distribution(report.entries.map((entry) => entry.root.chars)),
    root_over_12000_chars: report.entries.filter((entry) => entry.root.chars > 12000).map((entry) => ({ name: entry.name, chars: entry.root.chars, bytes: entry.root.bytes })),
    root_over_16000_chars: report.entries.filter((entry) => entry.root.chars > 16000).map((entry) => ({ name: entry.name, chars: entry.root.chars, bytes: entry.root.bytes, lines: entry.root.lines })),
    root_over_32000_chars: report.entries.filter((entry) => entry.root.chars > 32000).map((entry) => ({ name: entry.name, chars: entry.root.chars, bytes: entry.root.bytes })),
    payload_bytes: distribution(regular.map((entry) => entry.payload.text_bytes)),
    payload_parts_total: partTotals, payload_parts_share_percent: Object.fromEntries(Object.entries(partTotals).map(([key, value]) => [key, round(value / totalPayload * 100)])),
    payload_without_largest: { excluded: largestPayload?.name ?? null,
      total_bytes: withoutLargestBytes, parts: withoutLargestParts, shares_percent: Object.fromEntries(Object.entries(withoutLargestParts).map(([key, value]) =>
        [key, withoutLargestBytes ? round(value / withoutLargestBytes * 100) : 0])) },
    payload_thresholds: Object.fromEntries([16000, 32000, 64000, 128000, 512000, 1000000].map((limit) => [limit, regular.filter((entry) => entry.payload.text_bytes > limit).length])),
    largest_payloads: descending((entry) => entry.payload.text_bytes).slice(0, 25).map((entry) => ({ name: entry.name, ...entry.payload })),
    largest_roots: [...report.entries].sort((a, b) => b.root.bytes - a.root.bytes).slice(0, 25).map((entry) =>
      ({ name: entry.name, bytes: entry.root.bytes, chars: entry.root.chars, lines: entry.root.lines, code_fence_bytes: entry.root.code_fence_bytes })),
    largest_trees: descending((entry) => entry.payload.tree_bytes).slice(0, 15).map((entry) => ({ name: entry.name, bytes: entry.payload.tree_bytes, lines: entry.payload.tree_lines, catalog_files: entry.catalog.files })),
    largest_subskill_lists: descending((entry) => entry.payload.subskill_summary_bytes).slice(0, 15).map((entry) => ({ name: entry.name, bytes: entry.payload.subskill_summary_bytes, count: entry.subskills.count })),
    subskill_metadata: { returned: regular.reduce((sum, entry) => sum + entry.subskills.count, 0),
      omitted_by_existing_depth_or_skip_rules: regular.reduce((sum, entry) => sum + entry.catalog.omitted_nested_count, 0),
      empty_descriptions: regular.reduce((sum, entry) => sum + entry.subskills.empty_descriptions, 0),
      yaml_block_marker_descriptions: regular.reduce((sum, entry) => sum + entry.subskills.yaml_block_marker_descriptions, 0),
      quoted_descriptions: regular.reduce((sum, entry) => sum + entry.subskills.quoted_descriptions, 0) },
    text_documents_over_500k: { count: documentFiles.length, skills: new Set(documentFiles.map((file) => file.skill)).size,
      extension_counts: Object.fromEntries([...new Set(documentFiles.map((file) => extname(file.path).toLowerCase()))].map((ext) =>
        [ext, documentFiles.filter((file) => extname(file.path).toLowerCase() === ext).length])),
      files: documentFiles.sort((a, b) => b.bytes - a.bytes) },
    issue_counts: Object.fromEntries([...new Set(report.issues.map((issue) => issue.code))].map((code) => [code, report.issues.filter((issue) => issue.code === code).length])),
  };
  if (values["validate-yaml"]) {
    const validation = spawnSync("python3", ["-c", String.raw`
import collections, json, pathlib, re, sys, yaml
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "skills_manifest.json").read_text())
errors, mismatches = [], []
for entry in manifest:
    path = root / entry["relative_path"] / "SKILL.md"
    text = path.read_text(encoding="utf-8-sig")
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", text)
    if not match:
        errors.append({"name": entry["name"], "problem": "missing or malformed frontmatter boundary"})
        continue
    try:
        parsed = yaml.safe_load(match[1])
        if not isinstance(parsed, dict):
            errors.append({"name": entry["name"], "problem": "frontmatter is not a mapping"})
            continue
        for key in ["name", "description"]:
            if parsed.get(key) != entry[key]:
                mismatches.append({"name": entry["name"], "field": key, "root": parsed.get(key), "manifest": entry[key]})
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        errors.append({"name": entry["name"], "problem": getattr(error, "problem", str(error)),
            "root_line": mark.line + 2 if mark else None, "column": mark.column + 1 if mark else None,
            "source_line": match[1].splitlines()[mark.line] if mark else None})
print(json.dumps({"engine": "PyYAML " + yaml.__version__ + " safe_load",
    "valid": len(manifest) - len(errors), "invalid": len(errors),
    "problem_counts": dict(collections.Counter(error["problem"] for error in errors)),
    "errors": errors, "manifest_mismatches": mismatches}, ensure_ascii=False))
`, root], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    if (validation.status !== 0) throw new Error("Optional YAML audit failed: " + (validation.error?.message ?? validation.stderr));
    report.yaml_frontmatter_validation = JSON.parse(validation.stdout);
    report.notes.push("Optional PyYAML validation checks actual YAML syntax separately from the lightweight comparison extractor; no source content is modified.");
  }
  report.network_requests = networkRequests;
  report.completed_at = new Date().toISOString();
  report.detail_level = values.verbose ? "verbose" : values.full ? "all-entries" : "summary";
  if (!values.verbose && !values.full) {
    const ranked = [...report.entries].sort((a, b) => (b.payload?.text_bytes ?? 0) - (a.payload?.text_bytes ?? 0));
    report.entries = ranked.slice(0, 25).map((entry) => ({ name: entry.name, category: entry.category, relative_path: entry.relative_path,
      description_chars: entry.metadata.description_chars, aliases: entry.metadata.aliases.length, tags: entry.metadata.tags.length,
      root: { bytes: entry.root.bytes, chars: entry.root.chars },
      ...(entry.catalog ? { catalog: { files: entry.catalog.files, bytes: entry.catalog.bytes,
        nested_skills: entry.catalog.nested_skills, omitted_nested: entry.catalog.omitted_nested_count } } : {}),
      ...(entry.subskills ? { subskills: { count: entry.subskills.count, empty_descriptions: entry.subskills.empty_descriptions,
        yaml_block_marker_descriptions: entry.subskills.yaml_block_marker_descriptions, quoted_descriptions: entry.subskills.quoted_descriptions } } : {}),
      ...(entry.payload ? { payload: { text_bytes: entry.payload.text_bytes, json_bytes: entry.payload.json_bytes,
        instructions_bytes: entry.payload.instructions_bytes, tree_bytes: entry.payload.tree_bytes,
        subskill_summary_bytes: entry.payload.subskill_summary_bytes, overhead_bytes: entry.payload.overhead_bytes } } : {}),
    }));
  }
  if (values.full && !values.verbose) {
    report.entries = report.entries.map((entry) => ({ name: entry.name, category: entry.category, relative_path: entry.relative_path,
      description_chars: entry.metadata.description_chars, aliases: entry.metadata.aliases.length, tags: entry.metadata.tags.length,
      root: { bytes: entry.root.bytes, chars: entry.root.chars, lines: entry.root.lines },
      ...(entry.catalog ? { catalog: { files: entry.catalog.files, bytes: entry.catalog.bytes,
        nested_skills: entry.catalog.nested_skills, omitted_nested: entry.catalog.omitted_nested_count } } : {}),
      ...(entry.subskills ? { subskills: { count: entry.subskills.count, empty_descriptions: entry.subskills.empty_descriptions,
        yaml_block_marker_descriptions: entry.subskills.yaml_block_marker_descriptions, quoted_descriptions: entry.subskills.quoted_descriptions } } : {}),
      ...(entry.payload ? { payload: { text_bytes: entry.payload.text_bytes, json_bytes: entry.payload.json_bytes,
        instructions_bytes: entry.payload.instructions_bytes, tree_bytes: entry.payload.tree_bytes,
        subskill_summary_bytes: entry.payload.subskill_summary_bytes, overhead_bytes: entry.payload.overhead_bytes } } : {}),
      ...(entry.router_resource ? { router_resource: entry.router_resource } : {}),
    }));
    if (report.yaml_frontmatter_validation) {
      report.yaml_frontmatter_validation.examples = report.yaml_frontmatter_validation.errors.slice(0, 3);
      report.yaml_frontmatter_validation.errors = report.yaml_frontmatter_validation.errors.map(({ source_line, ...error }) => error);
    }
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) await fs.writeFile(resolve(values.output), json);
  process.stdout.write(json);
} finally { console.error = savedError; globalThis.fetch = savedFetch; }
