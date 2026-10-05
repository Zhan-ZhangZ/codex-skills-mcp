/**
 * Stage 0 deploy — per docs/PLUGIN-APP-PLAN.md §Stage 0.
 *
 * Copies the portable plugin to the personal plugin location and maintains
 * the personal marketplace the ChatGPT desktop app reads:
 *   plugin source   → ~/.codex/plugins/codex-skills/
 *   marketplace     → ~/.agents/plugins/marketplace.json  (root = ~)
 *                     entry path "./.codex/plugins/codex-skills"
 *
 * After running: restart the ChatGPT desktop app, install the plugin from
 * the Plugins Directory (marketplace "Codex Skills Local"), then verify MCP
 * startup in the activity log. Plugin content updates require re-running
 * this script + an app restart (host loads the installed cache copy).
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginSrc = path.join(repoRoot, "plugin");
const pluginDest = path.join(homedir(), ".codex", "plugins", "codex-skills");
const marketDir = path.join(homedir(), ".agents", "plugins");
const marketFile = path.join(marketDir, "marketplace.json");

const MARKETPLACE = "codex-skills-local";
const ENTRY = {
  name: "codex-skills",
  source: { source: "local", path: "./.codex/plugins/codex-skills" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
};

// 1) Deploy plugin content (portable files only)
await rm(pluginDest, { recursive: true, force: true });
await mkdir(path.dirname(pluginDest), { recursive: true });
await cp(pluginSrc, pluginDest, { recursive: true });
console.log(`plugin deployed → ${pluginDest}`);

// 2) Merge into the personal marketplace (preserve foreign entries)
let market = { name: MARKETPLACE, interface: { displayName: "Codex Skills Local" }, plugins: [] };
try {
  const existing = JSON.parse(await readFile(marketFile, "utf-8"));
  const foreign = (existing.plugins ?? []).filter((p) => p.name !== ENTRY.name && existing.name === MARKETPLACE ? true : p.name !== ENTRY.name);
  // Keep our marketplace entry list: entries from our marketplace minus ours, plus foreign marketplaces stay separate files — simple case: this file is ours.
  market.plugins = foreign;
} catch {
  // no existing marketplace file
}
market.plugins = market.plugins.filter((p) => p.name !== ENTRY.name);
market.plugins.push(ENTRY);
await mkdir(marketDir, { recursive: true });
await writeFile(marketFile, JSON.stringify(market, null, 2) + "\n", "utf-8");
console.log(`marketplace updated → ${marketFile} (${market.plugins.length} plugin[s])`);
console.log("\nNEXT: ⌘Q restart ChatGPT → Plugins 目录 → Codex Skills Local → install codex-skills");
