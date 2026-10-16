/** Always type-check and rebuild source assets before packaging the plugin. */
import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  external: ["express"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
await copyFile(resolve(root, "assets/app.html"), resolve(root, "plugin/dist/app.html"));
console.log("plugin/dist/server.js + app.html bundled from fresh build");
