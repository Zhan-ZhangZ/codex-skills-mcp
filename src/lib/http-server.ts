import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response, NextFunction } from "express";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  activeResponses: number;
}

interface HttpOptions {
  port: number;
  host?: string;
  allowedHosts?: string[];
  maxSessions?: number;
  sessionTtlMs?: number;
  sweepIntervalMs?: number;
  createServer: () => McpServer;
  health: () => Record<string, unknown>;
}

/** Stateful Streamable HTTP lifecycle, independent of CLI startup for testing. */
export async function startHttpServer(options: HttpOptions): Promise<{ listener: HttpServer; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host, allowedHosts: options.allowedHosts });
  const sessions = new Map<string, Session>();
  const maxSessions = options.maxSessions ?? 100;
  const ttl = options.sessionTtlMs ?? 30 * 60 * 1000;
  let pendingInitializations = 0;
  let shuttingDown = false;

  const error = (res: Response, status: number, message: string) => {
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  };
  // Browser origins must match a configured host as well as the Host header.
  const localHosts = ["127.0.0.1", "localhost", "[::1]"];
  const allowedOrigins = options.allowedHosts ?? (localHosts.includes(host) ? localHosts : [host]);
  app.use((req, res, next) => {
    if (shuttingDown) { error(res, 503, "Server is shutting down"); return; }
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (!["http:", "https:"].includes(origin.protocol) || !allowedOrigins.includes(origin.hostname)) {
          error(res, 403, "Origin is not allowed"); return;
        }
      } catch { error(res, 403, "Invalid Origin header"); return; }
    }
    next();
  });

  async function closeSession(sid: string, session: Session): Promise<void> {
    sessions.delete(sid);
    await session.server.close().catch(err => console.error("[codex-skills-mcp] Session close failed:", err));
  }
  const cleanup = setInterval(() => {
    for (const [sid, session] of sessions) {
      if (session.activeResponses === 0 && Date.now() - session.lastActivity > ttl) {
        void closeSession(sid, session);
      }
    }
  }, options.sweepIntervalMs ?? 5 * 60 * 1000);
  cleanup.unref();

  function trackResponse(session: Session, res: Response): void {
    session.lastActivity = Date.now();
    session.activeResponses++;
    res.once("close", () => {
      session.activeResponses--;
      session.lastActivity = Date.now();
    });
  }

  app.post("/mcp", async (req, res) => {
    const sid = req.headers["mcp-session-id"];
    if (sid !== undefined) {
      const session = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (!session) { error(res, 404, "Session not found; initialize a new session"); return; }
      trackResponse(session, res);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (!isInitializeRequest(req.body)) { error(res, 400, "Initialize a session before sending requests"); return; }
    if (sessions.size + pendingInitializations >= maxSessions) {
      error(res, 503, "Session capacity reached; retry later"); return;
    }
    pendingInitializations++;
    let session: Session | undefined;
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: sid => { if (session) sessions.set(sid, session); },
      });
      const server = options.createServer();
      session = { server, transport, lastActivity: Date.now(), activeResponses: 0 };
      server.server.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await server.connect(transport);
      trackResponse(session, res);
      await transport.handleRequest(req, res, req.body);
      // Invalid initialize payloads never retain an unregistered server.
      if (!transport.sessionId || !sessions.has(transport.sessionId)) await server.close();
    } catch (err) {
      if (session) await session.server.close().catch(() => {});
      throw err;
    } finally {
      pendingInitializations--;
    }
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sid = req.headers["mcp-session-id"];
    if (sid === undefined) { error(res, 400, "Missing session ID"); return; }
    const session = typeof sid === "string" ? sessions.get(sid) : undefined;
    if (!session) { error(res, 404, "Session not found; initialize a new session"); return; }
    trackResponse(session, res);
    await session.transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionRequest);
  app.delete("/mcp", sessionRequest);
  app.get("/health", (_req, res) => res.json({ ...options.health(), activeSessions: sessions.size }));
  app.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    console.error("[codex-skills-mcp] HTTP request failed:", err.message);
    error(res, status, status === 500 ? "Internal server error" : err.message);
  });

  let listener: HttpServer;
  try {
    listener = await new Promise<HttpServer>((resolve, reject) => {
      const server = app.listen(options.port, host, (err?: Error) => err ? reject(err) : resolve(server));
      server.once("error", reject);
    });
  } catch (err) { clearInterval(cleanup); throw err; }
  return { listener, close: async () => {
    shuttingDown = true;
    clearInterval(cleanup);
    const closed = new Promise<void>((resolve, reject) => listener.close(err => err ? reject(err) : resolve()));
    await Promise.all([...sessions].map(([sid, session]) => closeSession(sid, session)));
    listener.closeAllConnections();
    await closed;
  } };
}
