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

const [ , , cmd, ...rest ] = process.argv;
const SERVER_CMD = (process.env.CODEX_SKILLS_MCP_CMD || "node dist/index.js").split(" ");

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
const pending = new Map();

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function request(m, p) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: m, params: p });
  });
}

const timer = setTimeout(() => {
  console.error("[mcp-client] timed out");
  child.kill("SIGKILL");
  process.exit(2);
}, Number(process.env.MCP_CLIENT_TIMEOUT_MS || 180000));

child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString("utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

child.on("exit", (code) => {
  for (const { reject } of pending.values()) {
    reject(new Error("server exited early, code=" + code));
  }
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
  clearTimeout(timer);

  if (cmd === "instructions") {
    console.log(result?.instructions ?? "(no instructions returned)");
  } else if (cmd === "list") {
    console.log(result?.tools?.map((t) => t.name).join("\n") ?? "(none)");
  } else {
    const text = (result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(text || "(empty response)");
  }
  child.kill();
  process.exit(0);
} catch (err) {
  clearTimeout(timer);
  console.error("[mcp-client] request failed:", err.message);
  child.kill("SIGKILL");
  process.exit(1);
}
