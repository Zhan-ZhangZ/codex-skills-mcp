/** Validate the marketplace entry, manifests and bundled launcher surface. */
import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugin");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const [pkg, pluginPackage, portableManifest, codexManifest, portableMcp, codexMcp, marketplace] = await Promise.all([
  readJson(resolve(root, "package.json")),
  readJson(resolve(pluginRoot, "package.json")),
  readJson(resolve(pluginRoot, "plugin.json")),
  readJson(resolve(pluginRoot, ".codex-plugin/plugin.json")),
  readJson(resolve(pluginRoot, "mcp.json")),
  readJson(resolve(pluginRoot, ".mcp.json")),
  readJson(resolve(root, ".agents/plugins/marketplace.json")),
]);

assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "root version must be strict SemVer");
for (const [name, value] of [
  ["plugin/package.json", pluginPackage.version],
  ["plugin/plugin.json", portableManifest.version],
  ["plugin/.codex-plugin/plugin.json", codexManifest.version],
]) {
  assert.equal(value, pkg.version, `${name} must match the root package version`);
}
assert.equal(portableManifest.name, "codex-skills");
assert.equal(codexManifest.name, "codex-skills");
assert.equal(pluginPackage.name, "codex-skills-plugin");
assert.equal(pluginPackage.private, true);
assert.equal(portableManifest.extensions?.["com.openai"]?.requires_local_executor, true);
assert.equal(codexManifest.requires_local_executor, true);
assert.ok(Array.from(portableManifest.extensions["com.openai"].interface.shortDescription).length <= 30);

assert.equal(
  portableMcp.$schema,
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "portable mcp.json must declare the Agent Plugins schema",
);
const portableServer = portableMcp.mcpServers?.["codex-skills"];
const codexServer = codexMcp.mcpServers?.["codex-skills"];
assert.ok(portableServer, "portable mcp.json must expose codex-skills");
assert.ok(codexServer, ".mcp.json must expose codex-skills");
assert.equal(portableServer.type, "stdio");
assert.equal(portableServer.command, "./scripts/launch-codex-skills-mcp");
assert.equal(codexServer.command, portableServer.command);
assert.deepEqual(codexServer.args, portableServer.args);
assert.ok(codexServer.env_vars.includes("CODEX_MCP_NODE_PATH"));
assert.equal(portableServer.env?.CODEX_MCP_NODE_PATH, "${CODEX_MCP_NODE_PATH}");
assert.doesNotMatch(JSON.stringify([portableMcp, codexMcp]), /\b(npx|npm)\b/);

const marketplacePlugin = marketplace.plugins?.find((entry) => entry.name === portableManifest.name);
assert.ok(marketplacePlugin, "marketplace must expose the plugin");
assert.equal(marketplacePlugin.source?.source, "local");
assert.equal(marketplacePlugin.source?.path, "./plugin");
assert.deepEqual(await stat(resolve(root, marketplacePlugin.source.path)).then((value) => value.isDirectory()), true);

for (const required of [
  "dist/server.js",
  "dist/app.html",
  "plugin.json",
  "mcp.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "scripts/launch-codex-skills-mcp",
  "scripts/launch-codex-skills-mcp.cmd",
  "assets/icon.svg",
  "LICENSE",
  "NOTICE",
]) {
  await access(resolve(pluginRoot, required), constants.R_OK);
}
if (process.platform !== "win32") {
  const launcher = await stat(resolve(pluginRoot, "scripts/launch-codex-skills-mcp"));
  assert.ok((launcher.mode & 0o111) !== 0, "POSIX launcher must be executable");
}

console.log(`Codex Skills plugin ${pkg.version}: marketplace and manifests valid`);
