import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const payload = () => ({ submissionId: randomUUID(), answers: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i + 1, 3])) });
async function fixture(options: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-guard-http-'));
  const filename = join(directory, 'test.sqlite');
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('APP_') || name.startsWith('DINGTALK_')) delete env[name];
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    env: { ...env, HOST: '127.0.0.1', PORT: '0', BASE_URL: '', DATABASE_PATH: filename, ...options }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const base = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('startup timeout')), 5000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('early exit')); });
  });
  const db = new DatabaseSync(filename, { readOnly: true });
  return {
    base, db, filename,
    snapshot: () => ({ results: db.prepare('SELECT * FROM results ORDER BY id').all(), receipts: db.prepare('SELECT * FROM submission_receipts ORDER BY request_id').all(), queue: db.prepare('SELECT * FROM dingtalk_outbox ORDER BY result_id').all() }),
    async submit(data = payload(), headers: Record<string, string> = {}) {
      const response = await fetch(base + '/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
      return { response, body: await response.json() };
    },
    async close() { db.close(); child.kill('SIGTERM'); await exited; rmSync(directory, { recursive: true, force: true }); },
  };
}

test('HTTP enforces session/IP quotas, permits idempotent retries and cannot bypass IP limits with spoofed XFF', async () => {
  const f = await fixture({ APP_SUBMISSIONS_PER_IP_MINUTE: '2', APP_SUBMISSIONS_PER_SESSION_MINUTE: '1' });
  try {
    const data = payload();
    const first = await f.submit(data); assert.equal(first.response.status, 201);
    const cookie = first.response.headers.get('set-cookie')!.split(';')[0]!;
    const saved = f.snapshot();
    const retry = await f.submit(data, { cookie }); assert.equal(retry.response.status, 201); assert.deepEqual(retry.body, first.body);
    assert.deepEqual(f.snapshot(), saved);
    const deniedSession = await f.submit(payload(), { cookie }); assert.equal(deniedSession.response.status, 429);
    assert.ok(Number(deniedSession.response.headers.get('retry-after')) > 0); assert.deepEqual(f.snapshot(), saved);
    assert.equal((await f.submit()).response.status, 201);
    const before = f.snapshot();
    const deniedIp = await f.submit(payload(), { 'x-forwarded-for': '203.0.113.100' }); assert.equal(deniedIp.response.status, 429);
    assert.deepEqual(f.snapshot(), before);
    assert.equal((await f.submit(data, { cookie })).response.status, 201);
    assert.equal(f.snapshot().results.length, 2, 'equal scores from independent submissions remain separate');
  } finally { await f.close(); }
});

test('queue backlog rejects only new submissions atomically and recovers when a task is delivered', async () => {
  const f = await fixture({ APP_MAX_PENDING_SYNC: '1', DINGTALK_APP_KEY: 'test-key', DINGTALK_APP_SECRET: 'test-secret', DINGTALK_BASE_ID: 'test-base', DINGTALK_SHEET_ID_OR_NAME: 'test-sheet' });
  try {
    const data = payload(); const first = await f.submit(data); assert.equal(first.response.status, 201);
    const saved = f.snapshot(); assert.equal(saved.queue.length, 1);
    const blocked = await f.submit(); assert.equal(blocked.response.status, 503); assert.equal(blocked.response.headers.get('retry-after'), '30');
    assert.deepEqual(f.snapshot(), saved);
    const retry = await f.submit(data); assert.equal(retry.response.status, 201); assert.deepEqual(retry.body, first.body); assert.deepEqual(f.snapshot(), saved);
    const writer = new DatabaseSync(f.filename);
    try { writer.exec("UPDATE dingtalk_outbox SET synced_at = '2026-10-19T00:00:00.000Z' WHERE result_id = 1"); } finally { writer.close(); }
    assert.equal((await f.submit()).response.status, 201);
    assert.equal(f.snapshot().results.length, 2);
  } finally { await f.close(); }
});

test('read APIs are limited independently of non-API navigation, with no database writes', async () => {
  const f = await fixture({ APP_API_REQUESTS_PER_MINUTE: '1' });
  try {
    const saved = f.snapshot();
    const one = await fetch(f.base + '/api/results/decode?token=invalid'); assert.equal(one.status, 400); await one.arrayBuffer();
    const two = await fetch(f.base + '/api/results/decode?token=invalid'); assert.equal(two.status, 429); await two.arrayBuffer();
    const page = await fetch(f.base + '/test', { redirect: 'manual' }); assert.equal(page.status, 308); await page.arrayBuffer();
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(f.snapshot(), saved);
  } finally { await f.close(); }
});

test('configured proxy forwarding keeps separate clients separate and ignores spoofed addresses to their left', async () => {
  const f = await fixture({ APP_TRUSTED_PROXIES: '127.0.0.1', APP_SUBMISSIONS_PER_IP_MINUTE: '1' });
  try {
    const first = await f.submit(payload(), { 'x-forwarded-for': '192.0.2.5,203.0.113.1', 'x-forwarded-proto': 'https' });
    assert.equal(first.response.status, 201); assert.match(first.response.headers.get('set-cookie')!, /; Secure/);
    assert.equal((await f.submit(payload(), { 'x-forwarded-for': '203.0.113.2' })).response.status, 201);
    const saved = f.snapshot();
    const denied = await f.submit(payload(), { 'x-forwarded-for': '198.51.100.99,203.0.113.1' });
    assert.equal(denied.response.status, 429); assert.deepEqual(f.snapshot(), saved);
  } finally { await f.close(); }
});

test('raw HTTP dot-segment paths cannot bypass the guarded submission route', async () => {
  const f = await fixture({ APP_SUBMISSIONS_PER_IP_MINUTE: '1' });
  try {
    const nativePost = (path: string) => new Promise<number | undefined>((resolve, reject) => {
      const connection = request(f.base, { path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      connection.on('error', reject); connection.end(JSON.stringify(payload()));
    });
    assert.equal(await nativePost('/other/../api/results'), 201);
    assert.equal(await nativePost('/other/%2e%2e/api/results'), 429);
    assert.equal(f.snapshot().results.length, 1);
  } finally { await f.close(); }
});

test('a slow upload occupies a bounded slot, times out with 408 and releases capacity without partial writes', async () => {
  const f = await fixture({ APP_MAX_CONCURRENT_REQUESTS: '1', APP_BODY_TIMEOUT_MS: '700' });
  let stalled: ReturnType<typeof request> | undefined;
  try {
    const data = payload(), body = JSON.stringify(data);
    stalled = request(f.base + '/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    const response = new Promise<number | undefined>((resolve, reject) => { stalled!.on('error', reject); stalled!.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); });
    stalled.write(body.slice(0, 50));
    await new Promise(resolve => setTimeout(resolve, 100));
    const busy = await fetch(f.base + '/'); assert.equal(busy.status, 503); await busy.arrayBuffer();
    assert.equal(await response, 408); assert.equal(f.snapshot().results.length, 0);
    const retry = await f.submit(data); assert.equal(retry.response.status, 201);
    assert.equal(f.snapshot().receipts.length, 1);
  } finally { stalled?.destroy(); await f.close(); }
});

test('oversized declared and chunked bodies return 413, close the connection and never write records', async () => {
  const f = await fixture();
  try {
    for (const declared of [true, false]) {
      const connection = request(f.base + '/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': '50000' } : {}) } });
      const received = new Promise<number | undefined>((resolve, reject) => { connection.on('error', reject); connection.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); });
      if (declared) connection.write('{'); else connection.end(' '.repeat(20000));
      try { assert.equal(await received, 413); } finally { connection.destroy(); }
    }
    assert.equal(f.snapshot().results.length, 0); assert.equal(f.snapshot().receipts.length, 0);
  } finally { await f.close(); }
});

test('connection cap rejects excess sockets and stalled headers expire, without affecting later requests', { timeout: 8000 }, async () => {
  const f = await fixture({ APP_MAX_CONNECTIONS: '2', APP_HEADERS_TIMEOUT_MS: '200', APP_REQUEST_TIMEOUT_MS: '1500' });
  const sockets: ReturnType<typeof createConnection>[] = [];
  try {
    const port = Number(new URL(f.base).port);
    for (let i = 0; i < 2; i++) {
      const socket = createConnection({ host: '127.0.0.1', port }); sockets.push(socket); socket.on('error', () => {}); await once(socket, 'connect');
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nX-Wait: ');
    }
    const extra = createConnection({ host: '127.0.0.1', port }); sockets.push(extra); extra.on('error', () => {});
    await once(extra, 'close');
    const closed = sockets.slice(0, 2).map(socket => new Promise<string>(resolve => { let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('close', () => resolve(data)); }));
    for (const message of await Promise.all(closed)) assert.match(message, /408 Request Timeout/);
    const page = await fetch(f.base + '/test', { redirect: 'manual' }); assert.equal(page.status, 308); await page.arrayBuffer();
    assert.equal(f.snapshot().results.length, 0);
  } finally { sockets.forEach(socket => socket.destroy()); await f.close(); }
});
