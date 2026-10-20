import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("npm and plugin manifests expose Codex, ChatGPT and MCP discovery keywords", () => {
  const npm = readJson("package.json");
  const portable = readJson("plugin/plugin.json");
  const compatibility = readJson("plugin/.codex-plugin/plugin.json");
  const required = ["codex", "codex-plugin", "mcp", "mcp-server", "chatgpt"];

  for (const keyword of required) {
    assert.ok(npm.keywords.includes(keyword), `npm keyword missing: ${keyword}`);
    assert.ok(portable.keywords.includes(keyword), `portable plugin keyword missing: ${keyword}`);
    assert.ok(compatibility.keywords.includes(keyword), `Codex plugin keyword missing: ${keyword}`);
  }
});

test("the bundled local plugin is explicitly marked desktop-only", () => {
  const portable = readJson("plugin/plugin.json");
  const compatibility = readJson("plugin/.codex-plugin/plugin.json");

  assert.equal(portable.extensions?.["com.openai"]?.requires_local_executor, true);
  assert.equal(compatibility.requires_local_executor, true);
});

test("user documentation distinguishes MCP Apps UI from standard MCP clients", () => {
  const readme = readFileSync("README.md", "utf8");
  const installation = readFileSync("docs/INSTALLATION.md", "utf8");

  assert.match(readme, /skills\.tray/);
  assert.match(readme, /ChatGPT\s*桌面端|ChatGPT desktop app/);
  assert.match(readme, /Codex CLI/);
  assert.match(installation, /Codex CLI/);
  assert.match(installation, /Claude Desktop/);
  assert.match(installation, /Cursor/);
});
