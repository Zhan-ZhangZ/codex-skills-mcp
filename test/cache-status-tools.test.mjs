import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerReadSkill } from "../dist/tools/read-skill.js";
import { registerSkillStatus } from "../dist/tools/skill-status.js";

async function clientFor(t, cache) {
  const entry = { name: "sample", description: "Fixture", category: "test" };
  const engine = { findByName: (name) => name === entry.name ? entry : undefined };
  const loader = {
    downloadDeadlines: { softDeadlineMs: 0, hardDeadlineMs: 0 },
    cacheState: () => cache,
    readSkill: async () => ({ instructions: "# Cached instructions", dependencies: { language: "python" }, structure: { files: [], sub_skills: [] } }),
  };
  const server = new McpServer({ name: "cache-status-test", version: "1" });
  registerReadSkill(server, engine, loader);
  registerSkillStatus(server, engine, loader);
  const client = new Client({ name: "cache-status-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return {
    read: async () => (await client.callTool({ name: "read_skill", arguments: { name: "sample" } })).content[0].text,
    status: async () => (await client.callTool({ name: "skill_status", arguments: { names: "sample" } })).content[0].text,
  };
}
const cached = { cached: true, complete: false, localPath: "/fixture/sample", filesTotal: 13, filesMissing: [], sizeBytes: 1000 };

test("tools distinguish a complete old cache from an unvalidated current catalog", async (t) => {
  const client = await clientFor(t, { ...cached, catalogCurrent: false });
  const read = await client.read();
  const status = await client.status();
  for (const text of [read, status]) {
    assert.match(text, /cached revision/);
    assert.match(text, /current manifest catalog not validated/);
    assert.match(text, /when the source is available/);
    assert.doesNotMatch(text, /INCOMPLETE|missing 0\/13|0 of 13 files missing/);
  }
  assert.match(status, /0\/1 complete/);
  assert.match(read, /Cached instructions/);
  assert.match(read, /local_path/);
  assert.doesNotMatch(read, /The complete skill now lives|STEP 4: Execute/);
});

test("tools keep missing-file guidance and complete status for other cache states", async (t) => {
  const state = { ...cached, filesMissing: ["README.md"] };
  const client = await clientFor(t, state);
  const incomplete = await client.read();
  assert.match(incomplete, /INCOMPLETE — 1 of 13 files missing/);
  assert.match(incomplete, /Materialization is not complete/);
  assert.match(incomplete, /skill_status to verify completeness before execution/);
  assert.doesNotMatch(incomplete, /The complete skill now lives|STEP 4: Execute/);
  assert.match(await client.status(), /INCOMPLETE — missing 1\/13 files: README.md/);
  state.complete = true;
  state.filesMissing = [];
  const complete = await client.read();
  assert.match(complete, /complete — 13 files/);
  assert.match(complete, /The complete skill now lives/);
  assert.match(complete, /STEP 4: Execute/);
  assert.match(await client.status(), /1\/1 complete/);
});
