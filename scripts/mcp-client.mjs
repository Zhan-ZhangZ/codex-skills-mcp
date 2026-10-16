#!/usr/bin/env node
/**
 * Minimal stdio MCP client for codex-skills-mcp.
 *
 * Spawns the server (default: node dist/index.js, override with
 * CODEX_SKILLS_MCP_CMD), performs the MCP handshake, issues ONE request, and
 * prints the text content of the result. Designed for end-to-end tests and
 * for agent-driven verification (see docs/IMPROVEMENT-PLAN.md §8.2).
 *
 * Usage:
 *   node scripts/mcp-client.mjs instructions
 *   node scripts/mcp-client.mjs list
 *   node scripts/mcp-client.mjs call <tool> '<json-args>'
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [ , , cmd, ...rest ] = process.argv;
const SERVER_CMD = (process.env.CODEX_SKILLS_MCP_CMD || "node dist/index.js").trim().split(/\s+/);

function usageAndExit(code = 1) {
  console.error("Usage: node scripts/mcp-client.mjs instructions|list|call <tool> '<json-args>'");
  process.exit(code);
}

if (!cmd || !["instructions", "list", "call"].includes(cmd)) usageAndExit();

let method = "tools/list";
let params = {};
if (cmd === "instructions") {
  method = "initialize";
} else if (cmd === "call") {
  const tool = rest[0];
  if (!tool) usageAndExit();
  let args = {};
  if (rest[1]) {
    try { args = JSON.parse(rest[1]); } catch { console.error("Invalid JSON args"); usageAndExit(); }
  }
  method = "tools/call";
  params = { name: tool, arguments: args };
}

const child = spawn(SERVER_CMD[0], SERVER_CMD.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
let failure;
let timedOut = false;
const pending = new Map();

function fail(error) {
  failure ??= error;
  for (const { reject } of pending.values()) reject(failure);
  pending.clear();
}

function send(msg) {
  if (failure) throw failure;
  if (child.stdin.destroyed || child.stdin.writableEnded) throw new Error("server stdin closed");
  child.stdin.write(JSON.stringify(msg) + "\n", (error) => {
    if (error) fail(error);
  });
}

function request(method, params) {
  if (failure) return Promise.reject(failure);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      fail(error);
    }
  });
}

const configuredTimeout = Number(process.env.MCP_CLIENT_TIMEOUT_MS || 180000);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 180000;
const timer = setTimeout(() => {
  timedOut = true;
  fail(new Error("timed out"));
  child.kill("SIGKILL");
}, timeoutMs);

// A pipe chunk is neither a JSON-RPC frame nor necessarily a complete UTF-8
// character. readline buffers both safely, including the last line at EOF.
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
lines.on("close", () => {
  if (pending.size) fail(new Error("server stdout closed before a response"));
});
child.on("error", (error) => fail(new Error("server process failed: " + error.message)));
child.stdin.on("error", fail);
child.stdout.on("error", fail);
// close follows stdio draining; exit can precede the final response bytes.
child.on("close", (code, signal) => {
  fail(new Error("server exited early, " + (signal ? "signal=" + signal : "code=" + code)));
});

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-client-cli", version: "1.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  let result;
  if (cmd === "instructions") {
    result = init; // initialize result carries the server instructions
  } else {
    result = await request(method, params);
  }
  if (cmd === "instructions") {
    console.log(result?.instructions ?? "(no instructions returned)");
  } else if (cmd === "list") {
    // Print tool signatures (required args plain, optional in [brackets]) so
    // calling agents do not have to discover parameter names by trial and
    // error. Found during E2E rounds 3-4: param-name guessing wasted calls.
    const tools = result?.tools ?? [];
    if (tools.length === 0) {
      console.log("(none)");
    }
    for (const t of tools) {
      const props = t.inputSchema?.properties ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      const args = Object.keys(props)
        .map((p) => (required.has(p) ? p : "[" + p + "]"))
        .join(", ");
      console.log(t.name + "(" + args + ")");
    }
  } else {
    const text = (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(text || "(empty response)");
  }
  // Tool-level failures (e.g. zod argument validation) arrive as successful
  // RPC results with isError=true — surface them through the exit code so
  // calling scripts can detect failure. Found during E2E round 3.
  // Let stdout drain naturally: process.exit() truncates large piped results.
  process.exitCode = result?.isError ? 1 : 0;
} catch (err) {
  console.error("[mcp-client] request failed:", err.message);
  process.exitCode = timedOut ? 2 : 1;
} finally {
  clearTimeout(timer);
  lines.close();
  child.stdin.destroy();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    // Reap servers that ignore SIGTERM without hanging the verification CLI.
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
    child.once("close", () => clearTimeout(killTimer));
  }
}
