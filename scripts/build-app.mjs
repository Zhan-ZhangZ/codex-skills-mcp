/** Bundle a portable, self-contained app from source, independent of caller cwd. */
import { build, transform } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const [template, styles, pkg] = await Promise.all([
  readFile(resolve(root, "app-src/index.html"), "utf8"),
  readFile(require.resolve("@openai/mcp-extensions/app/styles.css"), "utf8"),
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
]);
for (const marker of ["<!-- APP_SCRIPT -->", "<!-- APP_STYLES -->"]) {
  if (template.split(marker).length !== 2) throw new Error("App template must contain exactly one " + marker);
}
const result = await build({
  absWorkingDir: root,
  entryPoints: ["app-src/controller.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  minify: true,
  legalComments: "none",
  write: false,
});
const code = result.outputFiles[0].text;
const css = (await transform(styles, { loader: "css", minify: true, legalComments: "none" })).code;
const html = template
  .replace("<!-- APP_STYLES -->", () => "<style>" + css.replace(/<\/style/gi, "<\\/style") + "</style>")
  .replace("<!-- APP_SCRIPT -->", () => "<script>" + code.replace(/<\/script/gi, "<\\/script") + "</script>");
await mkdir(resolve(root, "assets"), { recursive: true });
await writeFile(resolve(root, "assets/app.html"), html, "utf8");
console.log("assets/app.html built (" + (Buffer.byteLength(html) / 1024).toFixed(1) + " KB total, " + (Buffer.byteLength(code) / 1024).toFixed(1) + " KB script)");
