import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { HttpRequestBudget } from '../dist/remote/http-budget.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(limits = { capacity: 2, metadataReserve: 0, manifestReserve: 0 }) {
  const budget = new HttpRequestBudget(limits);
  const started = [];
  const operations = [];
  let active = 0;
  let peak = 0;
  const enqueue = (id, group = 'skill-a', kind = 'data') => {
    const controller = new AbortController();
    let resolve;
    let reject;
    const operation = new Promise((yes, no) => { resolve = yes; reject = no; });
    const task = { id, controller, finish: () => resolve(id), fail: error => reject(error) };
    task.result = budget.run({ kind, group, signal: controller.signal }, async () => {
      started.push(id);
      active++; peak = Math.max(peak, active);
      try { return await operation; } finally { active--; }
    });
    // Tests explicitly await results, but attach handlers before deliberate aborts.
    task.result.catch(() => {});
    operations.push(task);
    return task;
  };
  const finishAll = async () => {
    for (const operation of operations) operation.finish();
    await Promise.allSettled(operations.map(operation => operation.result));
  };
  return { budget, started, enqueue, finishAll, peak: () => peak };
}

test('budget validates reservations and isolates its limits from caller mutation', () => {
  for (const limits of [
    { capacity: 0, metadataReserve: 0, manifestReserve: 0 },
    { capacity: 8, metadataReserve: 8, manifestReserve: 0 },
    { capacity: 8, metadataReserve: 2, manifestReserve: 3 },
    { capacity: 8, metadataReserve: 2, manifestReserve: -1 },
    { capacity: 8.5, metadataReserve: 2, manifestReserve: 1 },
  ]) assert.throws(() => new HttpRequestBudget(limits), /Invalid HTTP budget/);
  const limits = { capacity: 8, metadataReserve: 2, manifestReserve: 1 };
  const budget = new HttpRequestBudget(limits);
  limits.capacity = 100;
  const snapshot = budget.snapshot();
  snapshot.limits.capacity = 100;
  snapshot.activeByKind.data = 100;
  assert.equal(budget.snapshot().limits.capacity, 8);
  assert.equal(budget.snapshot().activeByKind.data, 0);
});

test('all HTTP work shares a hard cap until complete operations settle', async () => {
  const f = fixture();
  const tasks = Array.from({ length: 10 }, (_, i) => f.enqueue(`file-${i}`, `skill-${i % 3}`));
  await flush();
  assert.equal(f.started.length, 2);
  assert.equal(f.budget.snapshot().active, 2);
  assert.equal(f.budget.snapshot().queued, 8);
  tasks[0].finish();
  await tasks[0].result;
  await flush();
  assert.equal(f.started.length, 3);
  await f.finishAll();
  assert.equal(f.peak(), 2);
  assert.deepEqual(f.budget.snapshot(), { active: 0, queued: 0, queuedGroups: 0,
    activeByKind: { data: 0, metadata: 0, manifest: 0 },
    limits: { capacity: 2, metadataReserve: 0, manifestReserve: 0 } });
});

test('data saturation leaves metadata and manifest reservations immediately available', async () => {
  const f = fixture({ capacity: 8, metadataReserve: 3, manifestReserve: 2 });
  for (let i = 0; i < 8; i++) f.enqueue(`data-${i}`);
  await flush();
  assert.equal(f.started.length, 5);
  f.enqueue('catalog-1', 'source-a', 'metadata');
  f.enqueue('catalog-2', 'source-b', 'metadata');
  await flush();
  assert.ok(f.started.includes('catalog-1'));
  assert.ok(!f.started.includes('catalog-2'));
  f.enqueue('manifest-raw', 'manifest', 'manifest');
  f.enqueue('manifest-api', 'manifest', 'manifest');
  await flush();
  assert.ok(f.started.includes('manifest-raw'));
  assert.ok(f.started.includes('manifest-api'));
  assert.deepEqual(f.budget.snapshot().activeByKind, { data: 5, metadata: 1, manifest: 2 });
  assert.equal(f.budget.snapshot().active, 8);
  await f.finishAll();
  assert.equal(f.peak(), 8);
});

test('metadata may borrow idle general capacity while preserving manifest slots', async () => {
  const f = fixture({ capacity: 8, metadataReserve: 3, manifestReserve: 2 });
  for (let i = 0; i < 9; i++) f.enqueue(`catalog-${i}`, `source-${i % 2}`, 'metadata');
  await flush();
  assert.equal(f.started.length, 6);
  f.enqueue('manifest-raw', 'source-c', 'manifest');
  f.enqueue('manifest-api', 'source-c', 'manifest');
  await flush();
  assert.equal(f.started.length, 8);
  assert.equal(f.budget.snapshot().active, 8);
  await f.finishAll();
});

test('round robin prevents one skill backlog from monopolizing released slots', async () => {
  const f = fixture({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  const head = f.enqueue('running');
  const a = Array.from({ length: 3 }, (_, i) => f.enqueue(`a-${i}`, 'skill-a'));
  const b = Array.from({ length: 3 }, (_, i) => f.enqueue(`b-${i}`, 'skill-b'));
  const c = f.enqueue('c-0', 'skill-c');
  head.finish();
  await head.result;
  await flush();
  assert.deepEqual(f.started, ['running', 'a-0']);
  a[0].finish(); await a[0].result; await flush();
  assert.deepEqual(f.started, ['running', 'a-0', 'b-0']);
  b[0].finish(); await b[0].result; await flush();
  assert.deepEqual(f.started, ['running', 'a-0', 'b-0', 'c-0']);
  c.finish(); await c.result; await flush();
  assert.equal(f.started.at(-1), 'a-1');
  await f.finishAll();
  assert.deepEqual(f.started, ['running', 'a-0', 'b-0', 'c-0', 'a-1', 'b-1', 'a-2', 'b-2']);
});

test('continuous metadata cannot starve an eligible queued data group', async () => {
  const f = fixture({ capacity: 3, metadataReserve: 1, manifestReserve: 1 });
  const m0 = f.enqueue('m-0', 'catalogs', 'metadata');
  const m1 = f.enqueue('m-1', 'catalogs', 'metadata');
  const m2 = f.enqueue('m-2', 'catalogs', 'metadata');
  f.enqueue('data', 'another-skill');
  f.enqueue('m-3', 'catalogs', 'metadata');
  await flush();
  m0.finish(); await m0.result; await flush();
  assert.equal(f.started.at(-1), 'm-2');
  m1.finish(); await m1.result; await flush();
  assert.equal(f.started.at(-1), 'data');
  await f.finishAll();
  assert.equal(f.peak(), 2, 'the last manifest reservation is not borrowed');
});

test('FIFO is preserved within a skill and rejected work releases its permit', async () => {
  const f = fixture({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  const a = f.enqueue('a');
  const b = f.enqueue('b');
  const c = f.enqueue('c');
  a.fail(new Error('transport failed'));
  await assert.rejects(a.result, /transport failed/);
  await flush();
  assert.deepEqual(f.started, ['a', 'b']);
  b.finish(); await b.result; await flush();
  assert.deepEqual(f.started, ['a', 'b', 'c']);
  await f.finishAll();
});

test('queued cancellation removes the request, group and abort listener without starting HTTP', async () => {
  const f = fixture({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  const running = f.enqueue('running');
  const queued = f.enqueue('cancelled', 'other');
  await flush();
  assert.equal(getEventListeners(queued.controller.signal, 'abort').length, 1);
  const reason = new Error('winner already completed');
  queued.controller.abort(reason);
  await assert.rejects(queued.result, error => error === reason);
  assert.equal(f.budget.snapshot().queued, 0);
  assert.equal(f.budget.snapshot().queuedGroups, 0);
  assert.equal(getEventListeners(queued.controller.signal, 'abort').length, 0);
  running.finish(); await running.result;
  assert.deepEqual(f.started, ['running']);
  assert.equal(f.budget.snapshot().active, 0);
});

test('aborting one queued group does not remove another group sharing the same name', async () => {
  const f = fixture({ capacity: 2, metadataReserve: 1, manifestReserve: 0 });
  const running = f.enqueue('data-running', 'shared');
  const meta = f.enqueue('metadata-running', 'shared', 'metadata');
  const queuedData = f.enqueue('data-cancelled', 'shared');
  const queuedMeta = f.enqueue('metadata-next', 'shared', 'metadata');
  queuedData.controller.abort(new Error('cancel data only'));
  await assert.rejects(queuedData.result, /cancel data only/);
  assert.equal(f.budget.snapshot().queued, 1);
  meta.finish(); await meta.result; await flush();
  assert.ok(f.started.includes('metadata-next'));
  await f.finishAll();
});

test('a pre-aborted request never enters the queue or starts HTTP', async () => {
  const budget = new HttpRequestBudget({ capacity: 2, metadataReserve: 0, manifestReserve: 0 });
  const controller = new AbortController();
  const reason = new Error('already expired');
  controller.abort(reason);
  let started = false;
  await assert.rejects(budget.run({ kind: 'data', group: 'skill', signal: controller.signal }, async () => { started = true; }), error => error === reason);
  assert.equal(started, false);
  assert.equal(budget.snapshot().active, 0);
  assert.equal(budget.snapshot().queued, 0);
});

test('abort between admission and callback execution releases the permit without HTTP', async () => {
  const budget = new HttpRequestBudget({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  const controller = new AbortController();
  let started = false;
  const pending = budget.run({ kind: 'data', group: 'skill', signal: controller.signal }, async () => { started = true; });
  controller.abort(new Error('cancelled during handoff'));
  await assert.rejects(pending, /cancelled during handoff/);
  assert.equal(started, false);
  assert.equal(budget.snapshot().active, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('active abort does not free the budget until the transport actually settles', async () => {
  const f = fixture({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  const active = f.enqueue('transport-ignores-abort');
  const next = f.enqueue('next');
  await flush();
  active.controller.abort(new Error('cancel active'));
  await flush();
  assert.deepEqual(f.started, ['transport-ignores-abort']);
  assert.equal(f.budget.snapshot().active, 1);
  active.finish(); await active.result; await flush();
  assert.deepEqual(f.started, ['transport-ignores-abort', 'next']);
  await f.finishAll();
  assert.equal(f.peak(), 1);
});

test('synchronous exceptions release permits and do not poison later admission', async () => {
  const budget = new HttpRequestBudget({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  const signal = new AbortController().signal;
  await assert.rejects(budget.run({ kind: 'data', group: 'skill', signal }, () => { throw new Error('sync failure'); }), /sync failure/);
  assert.equal(await budget.run({ kind: 'data', group: 'skill', signal }, async () => 'ok'), 'ok');
  assert.equal(budget.snapshot().active, 0);
});

test('a deadline started before admission expires in the queue without initiating a transfer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  f.enqueue('slow-body');
  const queued = f.enqueue('deadline-limited', 'other');
  const timeout = setTimeout(() => queued.controller.abort(new Error('deadline including queue')), 100);
  const rejected = assert.rejects(queued.result, /deadline including queue/);
  await flush();
  t.mock.timers.tick(100);
  await rejected;
  clearTimeout(timeout);
  assert.deepEqual(f.started, ['slow-body']);
  assert.equal(f.budget.snapshot().queued, 0);
  await f.finishAll();
  assert.deepEqual(f.started, ['slow-body']);
});

test('repeated queued cancellations do not retain groups or listeners', async () => {
  const f = fixture({ capacity: 1, metadataReserve: 0, manifestReserve: 0 });
  const active = f.enqueue('active');
  for (let i = 0; i < 1000; i++) {
    const pending = f.enqueue(`cancel-${i}`, `group-${i}`);
    pending.controller.abort(new Error('cancelled'));
    await assert.rejects(pending.result, /cancelled/);
    assert.equal(getEventListeners(pending.controller.signal, 'abort').length, 0);
  }
  assert.equal(f.budget.snapshot().queued, 0);
  assert.equal(f.budget.snapshot().queuedGroups, 0);
  active.finish(); await active.result;
  assert.equal(f.budget.snapshot().active, 0);
});

test('a default single-skill five-node fan-out fits while three skills remain globally bounded', async () => {
  const f = fixture({ capacity: 88, metadataReserve: 8, manifestReserve: 4 });
  for (let i = 0; i < 16 * 5; i++) f.enqueue(`first-${i}`, 'first-skill');
  await flush();
  assert.equal(f.started.length, 80, 'the existing default single-skill fan-out is not queued');
  for (let skill = 2; skill <= 3; skill++) {
    for (let i = 0; i < 16 * 5; i++) f.enqueue(`skill-${skill}-${i}`, `skill-${skill}`);
  }
  await flush();
  assert.equal(f.started.length, 80, 'three skills would previously start 240 HTTP attempts');
  assert.equal(f.budget.snapshot().queued, 160);
  for (let i = 0; i < 4; i++) f.enqueue(`catalog-${i}`, 'catalog', 'metadata');
  for (let i = 0; i < 4; i++) f.enqueue(`manifest-${i}`, 'manifest', 'manifest');
  await flush();
  assert.equal(f.budget.snapshot().active, 88);
  assert.equal(f.started.length, 88);
  await f.finishAll();
  assert.equal(f.peak(), 88);
  assert.equal(f.budget.snapshot().queued, 0);
});

test('capacity expansion drains waiting work, keeps reservations, and never shrinks', async () => {
  const f = fixture({ capacity: 4, metadataReserve: 2, manifestReserve: 1 });
  for (let i = 0; i < 8; i++) f.enqueue(`data-${i}`);
  await flush();
  assert.equal(f.started.length, 2);
  f.budget.expandCapacity(6);
  await flush();
  assert.equal(f.started.length, 4);
  assert.deepEqual(f.budget.snapshot().limits, { capacity: 6, metadataReserve: 2, manifestReserve: 1 });
  f.budget.expandCapacity(3);
  assert.equal(f.budget.snapshot().limits.capacity, 6);
  for (const invalid of [0, -1, 4.5, NaN, Infinity]) {
    assert.throws(() => f.budget.expandCapacity(invalid), /positive integer/);
  }
  await f.finishAll();
  assert.equal(f.peak(), 4);
});
