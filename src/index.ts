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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { parseConfig, loadManifest } from "./config.js";
import { SkillSearchEngine } from "./search/index.js";
import { SkillLoader } from "./loader/index.js";

import { registerSearchSkills } from "./tools/search-skills.js";
import { registerListCategories } from "./tools/list-categories.js";
import { registerReadSkill } from "./tools/read-skill.js";
import { registerLoadSkillFile } from "./tools/load-skill-file.js";
import { registerListSkillFiles } from "./tools/list-skill-files.js";
import { registerPlanWorkflow } from "./tools/plan-workflow.js";

function createServer(
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): McpServer {
  const server = new McpServer({
    name: "codex-skills",
    version: "1.0.7",
  });

  registerSearchSkills(server, searchEngine);
  registerListCategories(server, searchEngine);
  registerReadSkill(server, searchEngine, loader);
  registerLoadSkillFile(server, searchEngine, loader);
  registerListSkillFiles(server, searchEngine, loader);
  registerPlanWorkflow(server, searchEngine);

  return server;
}

async function startStdio(
  searchEngine: SkillSearchEngine,
  loader: SkillLoader
): Promise<void> {
  const server = createServer(searchEngine, loader);

  console.error("[codex-skills-mcp] 6 tools registered, starting stdio server...");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[codex-skills-mcp] Server running on stdio");
}

async function startHTTP(
  searchEngine: SkillSearchEngine,
  loader: SkillLoader,
  port: number
): Promise<void> {
  // Dynamic import to avoid loading express in stdio mode
  const { default: express } = await import("express");

  const app = express();
  app.use(express.json());

  // Session management with activity tracking for timeout cleanup
  const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout
  interface SessionEntry {
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
  }
  const sessions = new Map<string, SessionEntry>();

  /** Touch session activity timestamp */
  function touchSession(sid: string): void {
    const entry = sessions.get(sid);
    if (entry) entry.lastActivity = Date.now();
  }

  // Periodic cleanup of idle sessions (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        console.error(`[codex-skills-mcp] Evicting idle session: ${sid.substring(0, 8)}...`);
        try { entry.transport.close?.(); } catch { /* ignore */ }
        sessions.delete(sid);
      }
    }
  }, 5 * 60 * 1000).unref(); // unref so it doesn't prevent process exit

  // MCP endpoint — handles POST (messages) and GET (SSE stream) and DELETE (session close)
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId)!.transport;
      touchSession(sessionId);
    } else {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, lastActivity: Date.now() });
          console.error(`[codex-skills-mcp] New session: ${sid}`);
        },
      });

      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) sessions.delete(sid);
      };

      // Each session gets its own server instance
      const server = createServer(searchEngine, loader);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET endpoint for SSE stream (needed by some clients)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    touchSession(sessionId);
    const transport = sessions.get(sessionId)!.transport;
    await transport.handleRequest(req, res);
  });

  // DELETE endpoint for session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!.transport;
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
    } else {
      res.status(200).end();
    }
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      name: "codex-skills-mcp",
      version: "1.0.7",
      skills: searchEngine.getCategories().reduce((s, c) => s + c.skill_count, 0),
      activeSessions: sessions.size,
    });
  });

  console.error("[codex-skills-mcp] 6 tools registered, starting HTTP server...");

  app.listen(port, () => {
    console.error(`[codex-skills-mcp] HTTP server running at http://localhost:${port}/mcp`);
    console.error(`[codex-skills-mcp] Health check: http://localhost:${port}/health`);
    console.error(
      `[codex-skills-mcp] For remote clients: use ngrok or similar to expose this endpoint`
    );
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse configuration
  const config = parseConfig(args);

  if (config.isRemote) {
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
  const searchEngine = new SkillSearchEngine(manifest);
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
    const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : 3456;

    await startHTTP(searchEngine, loader, port);
  } else {
    await startStdio(searchEngine, loader);
  }
}

main().catch((err) => {
  console.error("[codex-skills-mcp] Fatal error:", err);
  process.exit(1);
});
