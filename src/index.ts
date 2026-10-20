#!/usr/bin/env node

/**
 * Codex-Skills MCP Server
 *
 * Provides intelligent search, read, and orchestration of the codex-skills
 * library via the Model Context Protocol (MCP).
 *
 * Supports two transport modes:
 *   1. stdio (default) — for Codex, ChatGPT, Claude Desktop, Cursor, Windsurf etc.
 *   2. HTTP  (--http)  — for remote clients or Streamable HTTP connections
 *
 * Usage:
 *   # stdio mode (default)
 *   node dist/index.js --skills-dir /path/to/codex-skills
 *
 *   # HTTP mode (for remote connections or HTTP clients)
 *   node dist/index.js --skills-dir /path/to/codex-skills --http --port 3456
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import { createRequire } from "node:module";

import { parseConfig, loadManifest, type ToolProfile } from "./config.js";
import { SkillSearchEngine } from "./search/index.js";
import { SkillLoader } from "./loader/index.js";
import { SERVER_INSTRUCTIONS } from "./lib/protocol.js";
import { initLogger, logEvent } from "./lib/logger.js";

import { registerSearchSkills } from "./tools/search-skills.js";
import { registerListCategories } from "./tools/list-categories.js";
import { registerReadSkill } from "./tools/read-skill.js";
import { registerLoadSkillFile } from "./tools/load-skill-file.js";
import { registerListSkillFiles } from "./tools/list-skill-files.js";
import { registerPlanWorkflow } from "./tools/plan-workflow.js";
import { registerSkillStatus } from "./tools/skill-status.js";
import { registerDiagnostics } from "./tools/diagnostics.js";
import { registerOpenAISettings, applyPersistedSettingsAtStartup } from "./openai/settings.js";
import { registerOpenAIMentions, registerSkillResources } from "./openai/mentions.js";
import { registerCodexSkillsApp } from "./openai/app.js";

// Single source of truth for the version: read package.json instead of
// hardcoding it here, so releasing a new version only requires one bump.
const require = createRequire(import.meta.url);
const PKG_VERSION = require("../package.json").version as string;

const CORE_TOOL_NAMES = new Set([
  "search_skills",
  "list_categories",
  "read_skill",
  "load_skill_file",
  "list_skill_files",
  "plan_workflow",
  "skill_status",
  "diagnostics",
]);

function resolveToolProfile(
  server: McpServer,
  configured: ToolProfile
): "core" | "full" {
  if (configured === "core" || configured === "full") return configured;
  const info = server.server.getClientVersion();
  const identity = `${info?.name ?? ""} ${(info as Record<string, unknown> | undefined)?.title ?? ""}`
    .toLocaleLowerCase();
  // The integrated ChatGPT desktop / Codex MCP Apps host identifies itself as
  // `codex-mcp-client` (not `codex`). Keep its UI, @ mentions and tray.
  if (/codex-mcp-client|codex desktop|chatgpt|openai/.test(identity)) return "full";
  // The Codex CLI and unknown generic MCP clients stay on the 8-tool surface.
  return "core";
}

function applyToolProfile(server: McpServer, profile: "core" | "full"): void {
  // McpServer filters tools/list and tools/call by this mutable flag. Keeping
  // every tool registered preserves full-surface capability; core clients
  // merely stop seeing/being able to call the host/UI tools.
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { enabled: boolean }>;
  })._registeredTools;
  if (!registry) throw new Error("McpServer tool registry is unavailable");
  let exposed = 0;
  for (const [name, tool] of Object.entries(registry)) {
    tool.enabled = profile === "full" || CORE_TOOL_NAMES.has(name);
    if (tool.enabled) exposed++;
  }
  console.error(
    `[codex-skills-mcp] tool profile ${profile}: ${exposed}/${Object.keys(registry).length} tools exposed`
  );
}

function createServer(
  config: ReturnType<typeof parseConfig>,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): McpServer {
  const server = new McpServer(
    { name: "codex-skills", version: PKG_VERSION },
    {
      // The agent-facing behavioral contract (docs/AGENT-PROTOCOL.md) is
      // returned to clients in the initialize result and reinforced in every
      // tool description and result footer.
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  registerSearchSkills(server, searchEngine, loader);
  registerListCategories(server, searchEngine);
  registerReadSkill(server, searchEngine, loader);
  registerLoadSkillFile(server, searchEngine, loader);
  registerListSkillFiles(server, searchEngine, loader);
  registerPlanWorkflow(server, searchEngine, loader);
  registerSkillStatus(server, searchEngine, loader);
  registerDiagnostics(server, config, searchEngine, loader, PKG_VERSION);
  // Resources are not tools. Keep skill:// reads available in core mode so
  // clients can still resolve a selected skill without the App surface.
  registerSkillResources(server, config, searchEngine, loader);

  // OpenAI MCP Extensions (Phase 1): structured settings + composer mentions.
  // They must be registered before connect; profile filtering decides whether
  // they are visible/callable by the model.
  const openai = new OpenAIExtensions(server);
  registerOpenAISettings(server, openai, config, searchEngine);
  registerOpenAIMentions(server, openai, config, searchEngine, loader, false);

  // MCP App (Stage 1): sidebar entrypoints served from bundled app.html.
  const appRegistered = registerCodexSkillsApp(server, searchEngine, loader);
  console.error(
    `[codex-skills-mcp] ${12 + (appRegistered ? 10 : 0)} tools registered ` +
    `(8 core + 4 openai-extension${appRegistered ? " + 10 app tools" : ""})`
  );

  if (config.toolProfile === "full") {
    applyToolProfile(server, "full");
  } else if (config.toolProfile === "core") {
    applyToolProfile(server, "core");
  } else {
    console.error("[codex-skills-mcp] tool profile: auto (resolved after initialize)");
    server.server.oninitialized = () => {
      const profile = resolveToolProfile(server, config.toolProfile);
      const info = server.server.getClientVersion();
      console.error(
        `[codex-skills-mcp] client ${info?.name ?? "unknown"} -> ${profile} tool profile`
      );
      applyToolProfile(server, profile);
      if (server.server.transport) {
        void server.server.sendToolListChanged().catch((error) => {
          console.error("[codex-skills-mcp] Could not notify tool list change:", error);
        });
      }
    };
  }

  return server;
}

async function startStdio(
  config: ReturnType<typeof parseConfig>,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): Promise<void> {
  const server = createServer(config, searchEngine, loader);

  console.error("[codex-skills-mcp] starting stdio server...");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[codex-skills-mcp] Server running on stdio");
}

async function startHTTP(
  config: ReturnType<typeof parseConfig>,
  searchEngine: SkillSearchEngine,
  loader: SkillLoader,
  port: number
): Promise<void> {
  const { startHttpServer } = await import("./lib/http-server.js");
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(name + " requires a value");
    return value;
  };
  const host = option("--host") ?? "127.0.0.1";
  const allowedHosts = option("--allowed-hosts")?.split(",").map(v => v.trim()).filter(Boolean);
  const http = await startHttpServer({
    port, host, allowedHosts,
    createServer: () => createServer(config, searchEngine, loader),
    health: () => ({
      status: "ok", name: "codex-skills-mcp", version: PKG_VERSION,
      skills: searchEngine.allSkills().length,
    }),
  });
  const address = http.listener.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.error("[codex-skills-mcp] HTTP server running at http://" + host + ":" + actualPort + "/mcp");
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    void http.close().then(() => {
      clearTimeout(timer);
      process.exit(0);
    }, err => { console.error(err); process.exit(1); });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--version")) { console.log(PKG_VERSION); return; }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`codex-skills-mcp ${PKG_VERSION}
Usage: codex-skills-mcp [options]

  --skills-dir <path>            Use a local skill library (offline)
  --cache-dir <path>             Remote cache directory
  --github-repo <owner/repo>     Remote repository
  --github-branch <ref>          Remote branch (default: main)
  --github-path <path>           Skill library path within the repository
  --github-token <token>         GitHub token (or GITHUB_TOKEN)
  --no-official-mirror           Disable the official acceleration endpoint
  --no-hedge                     Race all download nodes immediately
  --download-concurrency <1–64>  Parallel file downloads (default: 16)
  --download-timeout <1–300>     Request/race seconds (default: 30)
  --manifest-ttl <seconds>       Cache TTL (0–604800; 0 disables expiry)
  --manifest-poll <seconds>      Background freshness check (0–3600)
  --soft-deadline-seconds <n>    No-progress call deadline (default: 55)
  --hard-deadline-seconds <n>    All-call deadline (default: 285)
  --tool-profile <mode>          auto | core (8 agent tools) | full (22 tools)
  --http                        Use Streamable HTTP instead of stdio
  --host <address>              HTTP bind address (default: 127.0.0.1)
  --port <0–65535>               HTTP port (default: 3456; 0 selects a port)
  --allowed-hosts <a,b>          Allowed Host/Origin hostnames for HTTP
  --version                     Print version
  --help                        Show this help`);
    return;
  }

  // Parse configuration
  const config = parseConfig(args);

  // Overlay user settings persisted via the openai/settings extension so
  // they survive restarts and take effect before remote init / manifest fetch.
  applyPersistedSettingsAtStartup(config);

  if (config.isRemote) {
    // Activity log lives under <cacheDir>/logs (remote mode only, so local
    // skill libraries are never polluted). See docs/ARCHITECTURE.md.
    initLogger(config.skillsDir);
    logEvent("info", "server_start", { detail: `v${PKG_VERSION} remote mode` });
    const { initRemote, fetchManifest } = await import("./remote/github.js");
    console.error("[codex-skills-mcp] Initializing remote GitHub fetching...");
    await initRemote(config);
    await fetchManifest(config);
  }

  // Load manifest
  console.error(`[codex-skills-mcp] Loading manifest from: ${config.manifestPath}`);
  const manifest = loadManifest(config.manifestPath);
  console.error(`[codex-skills-mcp] Loaded ${manifest.length} skills`);

  // Build search index
  const searchEngine = new SkillSearchEngine(manifest, config);
  const categories = searchEngine.getCategories();
  console.error(
    `[codex-skills-mcp] Index built: ${categories.length} categories, ` +
      `${categories.reduce((s, c) => s + c.skill_count, 0)} indexed skills`
  );

  // Create skill loader
  const loader = new SkillLoader(config, manifest);

  // Determine transport mode
  const useHTTP = args.includes("--http");

  if (useHTTP) {
    // Parse port
    const portIdx = args.indexOf("--port");
    const portText = portIdx !== -1 ? args[portIdx + 1] : "3456";
    const port = Number(portText);
    if (!portText || !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("--port must be an integer between 0 and 65535");
    }

    await startHTTP(config, searchEngine, loader, port);
  } else {
    await startStdio(config, searchEngine, loader);
  }
}

main().catch((err) => {
  console.error("[codex-skills-mcp] Fatal error:", err);
  process.exit(1);
});
