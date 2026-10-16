#!/usr/bin/env node
/** Measure real MCP stdio read/navigation calls against a built server. */
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values } = parseArgs({ options: {
  dist: { type: "string", default: resolve("dist/index.js") },
  "source-root": { type: "string", default: resolve("../codexproject/codex-skills") },
  skill: { type: "string", default: "Awesome-Journal-Skills" },
  output: { type: "string" },
} });
const dist = resolve(values.dist);
const sourceRoot = resolve(values["source-root"]);
const transport = new StdioClientTransport({ command: process.execPath, args: [dist, "--skills-dir", sourceRoot], stderr: "pipe" });
const client = new Client({ name: "navigation-benchmark", version: "1.0.0" });
const stderr = [];
transport.stderr.on("data", chunk => stderr.push(chunk));
const call = async (name, arguments_ = {}) => {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: arguments_ });
  const elapsed = Math.round(performance.now() - started);
  const serialized = JSON.stringify(result);
  return { elapsed_ms: elapsed, wire_json_bytes: Buffer.byteLength(serialized),
    text_bytes: result.content?.filter(item => item.type === "text")
      .reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) ?? 0,
    isError: result.isError === true };
};
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const repeated = async (name, arguments_, count = 5) => {
    const attempts = [];
    for (let index = 0; index < count; index++) attempts.push(await call(name, arguments_));
    const elapsed = attempts.map(attempt => attempt.elapsed_ms).sort((a, b) => a - b);
    return { ...attempts[0], elapsed_ms: elapsed[Math.floor(elapsed.length / 2)],
      attempts: attempts.map(attempt => ({ elapsed_ms: attempt.elapsed_ms, wire_json_bytes: attempt.wire_json_bytes })) };
  };
  const first = await call("read_skill", { name: values.skill });
  const warm = await repeated("read_skill", { name: values.skill });
  const files = await repeated("list_skill_files", { skill_name: values.skill, max_depth: 2 }, 3);
  const subSkills = await repeated("list_skill_files", { skill_name: values.skill, view: "sub_skills", query: "survey design", limit: 50 }, 3);
  const report = { started_at: new Date().toISOString(), dist, source_root: sourceRoot, skill: values.skill,
    tool_count: tools.tools.length, calls: { read_first: first, read_warm_median: warm,
      list_files_median: files, list_subskills_filtered_median: subSkills }, stderr_tail: stderr.join("").split(/\r?\n/).slice(-20) };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) await fs.writeFile(resolve(values.output), json);
  process.stdout.write(json);
} finally { await client.close(); }
