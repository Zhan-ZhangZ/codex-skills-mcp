import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../dist/lib/http-server.js';

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
} };
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function fixture(t, options = {}) {
  let created = 0;
  const http = await startHttpServer({
    port: 0, health: () => ({ status: 'ok' }),
    createServer: () => {
      created++;
      const server = new McpServer({ name: 'test', version: '1' });
      server.tool('echo', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      return server;
    }, ...options,
  });
  t.after(() => http.close());
  const base = 'http://127.0.0.1:' + http.listener.address().port;
  const request = (method = 'POST', body = initialize, extra = {}) => fetch(base + '/mcp', {
    method, headers: { ...headers, ...extra }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { ...http, base, request, created: () => created };
}

test('invalid/expired requests allocate no sessions and use protocol status codes', async t => {
  const f = await fixture(t);
  let response = await f.request('POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(response.status, 400); await response.text();
  for (const method of ['POST', 'GET', 'DELETE']) {
    response = await f.request(method, initialize, { 'mcp-session-id': 'expired' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).jsonrpc, '2.0');
  }
  for (const method of ['GET', 'DELETE']) {
    response = await f.request(method);
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(f.created(), 0);
});

test('official SDK client initializes, calls tools and deletes the session', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'sdk-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(f.base + '/mcp'));
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.callTool({ name: 'echo', arguments: {} })).content[0].text, 'ok');
  assert.equal((await (await fetch(f.base + '/health')).json()).activeSessions, 1);
  await transport.terminateSession();
  assert.equal((await (await fetch(f.base + '/health')).json()).activeSessions, 0);
});

test('session cap, malformed initialization and local Host/Origin validation', async t => {
  const f = await fixture(t, { maxSessions: 1 });
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/mcp', { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(JSON.stringify(initialize));
  });
  assert.equal(hostStatus, 403);
  let response = await f.request('POST', initialize, { Origin: 'https://evil.example' });
  assert.equal(response.status, 403); await response.text();
  response = await f.request('POST', { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(response.status, 400); await response.text();
  response = await f.request();
  assert.equal(response.status, 200);
  const sid = response.headers.get('mcp-session-id');
  assert.ok(sid); await response.text();
  response = await f.request();
  assert.equal(response.status, 503); await response.text();
  response = await f.request('DELETE', undefined, { 'mcp-session-id': sid });
  assert.equal(response.status, 200); await response.text();
  response = await f.request();
  assert.equal(response.status, 200); await response.text();
});

test('idle sessions are evicted while active SSE streams stay alive', async t => {
  const f = await fixture(t, { sessionTtlMs: 50, sweepIntervalMs: 10 });
  const response = await f.request();
  const sid = response.headers.get('mcp-session-id');
  await response.text();
  const stream = await f.request('GET', undefined, { 'mcp-session-id': sid });
  assert.equal(stream.status, 200);
  await delay(120);
  assert.equal((await (await fetch(f.base + '/health')).json()).activeSessions, 1);
  await stream.body.cancel();
  for (let i = 0; i < 30; i++) {
    if ((await (await fetch(f.base + '/health')).json()).activeSessions === 0) return;
    await delay(20);
  }
  assert.fail('idle session did not expire');
});

test('port collisions reject startup instead of leaving an unhealthy process', async t => {
  const f = await fixture(t);
  await assert.rejects(startHttpServer({ port: f.listener.address().port,
    createServer: () => new McpServer({ name: 'test', version: '1' }), health: () => ({}),
  }), { code: 'EADDRINUSE' });
});
