import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/mcp-client.mjs", import.meta.url));
const largeText = "技能预览：你好世界。".repeat(25_000);
const mockSource = String.raw`
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
const lines = createInterface({ input: process.stdin });
const mode = process.env.MOCK_MCP_MODE;
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  if (mode === "early-exit") { process.exit(7); return; }
  if (mode === "timeout") return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" }, instructions: "Mock instructions" }
    : { content: [{ type: "text", text: mode === "split" ? "技能预览：你好世界。".repeat(25_000) : mode === "is-error" ? "tool validation failed" : "final response" }], isError: mode === "is-error" };
  const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  if (mode === "split") {
    // Split JSON syntax and all three bytes of the first Chinese character.
    const chinese = data.indexOf(Buffer.from("技"));
    const offsets = chinese >= 0 ? [7, chinese + 1, chinese + 2, data.length - 1, data.length] : [7, 19, data.length];
    let position = 0;
    for (const end of offsets) {
      process.stdout.write(data.subarray(position, end));
      position = end;
      await delay(8);
    }
  } else if (mode === "eof" && request.method !== "initialize") {
    // Valid final message at EOF, without a newline. Exit only after flushing.
    process.stdout.write(data.subarray(0, data.length - 1), () => process.exit(0));
  } else {
    process.stdout.write(data);
  }
});
`;

async function mock(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = join(directory, "server.mjs");
  await writeFile(server, mockSource);
  return { ...process.env, CODEX_SKILLS_MCP_CMD: process.execPath + " " + server, MOCK_MCP_MODE: mode, MCP_CLIENT_TIMEOUT_MS: "10000" };
}

function run(env, args = ["call", "sample", "{}"], timeout = 5000) {
  const start = performance.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, killed: error?.killed ?? false, stdout, stderr, elapsed: performance.now() - start });
    });
  });
}

test("CLI preserves JSON and UTF-8 across chunks and drains large output", async (t) => {
  const result = await run(await mock(t, "split"));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, largeText + "\n");
  assert.equal(result.killed, false);
});

test("CLI reports a tool-level isError as exit code 1", async (t) => {
  const result = await run(await mock(t, "is-error"));
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "tool validation failed\n");
});

test("CLI fails promptly when spawning the server fails", async () => {
  const result = await run({ ...process.env, CODEX_SKILLS_MCP_CMD: "/codex-mcp-nonexistent-command-for-test", MCP_CLIENT_TIMEOUT_MS: "30000" });
  assert.equal(result.code, 1);
  assert.equal(result.killed, false);
  assert.match(result.stderr, /server process failed.*ENOENT/);
  assert.ok(result.elapsed < 3000, "spawn failure should not wait for the request timeout");
});

test("CLI rejects early server exit without waiting for the timeout", async (t) => {
  const result = await run(await mock(t, "early-exit"));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /server (?:stdout closed|exited early)/);
  assert.ok(result.elapsed < 3000);
});

test("CLI reads a final response at EOF before reacting to process exit", async (t) => {
  const result = await run(await mock(t, "eof"));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "final response\n");
});

test("CLI retains exit code 2 for request timeout", async (t) => {
  const env = await mock(t, "timeout");
  env.MCP_CLIENT_TIMEOUT_MS = "100";
  const result = await run(env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /timed out/);
});
