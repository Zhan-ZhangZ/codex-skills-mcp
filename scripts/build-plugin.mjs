/** Bundle the MCP server into plugin/dist/server.js (official plugin pattern). */
import { build } from "esbuild";
await build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "plugin/dist/server.js",
  external: ["express"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
import { copyFileSync } from "node:fs";
copyFileSync("assets/app.html", "plugin/dist/app.html");
console.log("plugin/dist/server.js + app.html bundled");
