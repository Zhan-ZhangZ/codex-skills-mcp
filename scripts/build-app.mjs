/** Bundle the app frontend into a single self-contained HTML (official pattern). */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["app-src/controller.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  write: false,
});
const code = result.outputFiles[0].text;
const template = await readFile("app-src/index.html", "utf8");
await writeFile(
  "assets/app.html",
  template.replace(
    "<!-- APP_SCRIPT -->",
    () => `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`
  ),
  "utf8"
);
console.log(`assets/app.html built (${(code.length / 1024).toFixed(0)}KB script inlined)`);
