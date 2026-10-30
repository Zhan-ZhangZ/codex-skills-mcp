import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { UsageTelemetry } = await import("../dist/lib/usage-telemetry.js");

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-skills-telemetry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const usagePath = join(dir, "usage.json");
  let now = new Date("2026-10-30T08:00:00.000Z");
  const requests = [];
  let nextId = 1;
  const reporter = new UsageTelemetry({
    stateDir: dir,
    usagePath,
    pluginVersion: "1.7.0",
    enabled: true,
    autoStart: false,
    now: () => now,
    randomUUIDImpl: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
    ...overrides,
  });
  return {
    dir,
    usagePath,
    reporter,
    requests,
    setNow(value) { now = new Date(value); },
  };
}

test("uploads one historical backfill immediately, then daily deltas", async (t) => {
  const f = fixture(t);
  writeFileSync(f.usagePath, JSON.stringify({
    ppt: { reads: 40, failures: 2, lastReadAt: 1 },
    video: { reads: 7, failures: 0, lastReadAt: 2 },
  }));
  f.reporter.capture();
  await f.reporter.flushPending();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body.skills, [
    { name: "ppt", count: 40 },
    { name: "video", count: 7 },
  ]);

  writeFileSync(f.usagePath, JSON.stringify({
    ppt: { reads: 43, failures: 2, lastReadAt: 3 },
    video: { reads: 7, failures: 0, lastReadAt: 2 },
    "new-skill": { reads: 2, failures: 0, lastReadAt: 4 },
  }));
  f.reporter.capture();
  f.setNow("2026-10-31T00:15:00.000Z");
  await f.reporter.flushPending();

  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url, "https://gh.251716.xyz/api/skill-usage/v1/batch");
  assert.match(f.requests[1].body.batch_id, /^[0-9a-f-]{36}$/);
  const { batch_id: _ignored, ...dailyPayload } = f.requests[1].body;
  assert.deepEqual(dailyPayload, {
    schema_version: 1,
    plugin_version: "1.7.0",
    day: "2026-10-30",
    skills: [
      { name: "new-skill", count: 2 },
      { name: "ppt", count: 3 },
    ],
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.dir, "skill-usage-telemetry.json"), "utf8")).days,
    {},
  );
});

test("disabling uploads keeps local deltas and sends them after re-enable", async (t) => {
  const f = fixture(t);
  writeFileSync(f.usagePath, JSON.stringify({ ppt: { reads: 1 } }));
  f.reporter.capture();
  f.reporter.disable();
  writeFileSync(f.usagePath, JSON.stringify({ ppt: { reads: 4 } }));
  f.reporter.capture();
  f.setNow("2026-10-31T01:00:00.000Z");
  await f.reporter.flushPending();
  assert.deepEqual(f.requests, []);

  f.reporter.enable();
  await f.reporter.flushPending();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].body.skills[0].count, 1);
  assert.equal(f.requests[1].body.skills[0].count, 3);
});

test("failed uploads retain the same idempotency batch", async (t) => {
  let succeed = false;
  const f = fixture(t, {
    fetchImpl: async (url, init) => {
      f.requests.push({ url, body: JSON.parse(init.body) });
      return new Response(null, { status: succeed ? 204 : 503 });
    },
  });
  writeFileSync(f.usagePath, JSON.stringify({ ppt: { reads: 1 } }));
  f.reporter.capture();
  writeFileSync(f.usagePath, JSON.stringify({ ppt: { reads: 2 } }));
  f.reporter.capture();
  f.setNow("2026-10-31T01:00:00.000Z");
  await f.reporter.flushPending();
  succeed = true;
  await f.reporter.flushPending();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[0].body.batch_id, f.requests[1].body.batch_id);
  assert.notEqual(f.requests[1].body.batch_id, f.requests[2].body.batch_id);
});
