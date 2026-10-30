/** Always type-check and rebuild source assets before packaging the plugin. */
import { build } from "esbuild";
import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugin");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

async function syncVersion(path) {
  const data = JSON.parse(await readFile(path, "utf8"));
  data.version = pkg.version;
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

await Promise.all([
  syncVersion(resolve(root, "plugin/package.json")),
  syncVersion(resolve(root, "plugin/plugin.json")),
  syncVersion(resolve(root, "plugin/.codex-plugin/plugin.json")),
]);

execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: "inherit" });
await build({
  absWorkingDir: root,
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  outfile: "plugin/dist/server.js",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
await copyFile(resolve(root, "assets/app.html"), resolve(root, "plugin/dist/app.html"));
await copyFile(resolve(root, "LICENSE"), resolve(root, "plugin/LICENSE"));
await copyFile(resolve(root, "NOTICE"), resolve(root, "plugin/NOTICE"));
if (process.platform !== "win32") {
  await chmod(resolve(pluginRoot, "dist/server.js"), 0o755);
  await chmod(resolve(pluginRoot, "scripts/launch-codex-skills-mcp"), 0o755);
}
console.log(`Codex Skills plugin ${pkg.version} bundled without npm lifecycle dependencies`);
