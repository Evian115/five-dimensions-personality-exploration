import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QUESTIONS } from '../src/index.ts';

test('HTTP submissions queue without an operator, survive remote lost responses and restart, and sync each independent submission once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-dingtalk-http-'));
  const filename = join(directory, 'test.sqlite');
  const remote = new Map<string, { id: string; body: string }>();
  const received: { token: string; fields: Record<string, unknown> }[] = [];
  let tokens = 0;
  const mock = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1.0/oauth2/accessToken') {
      tokens++;
      assert.deepEqual(JSON.parse(body), { appKey: 'fake-key', appSecret: 'fake-private-secret' });
      res.end(JSON.stringify({ accessToken: 'fake-private-token', expireIn: 7200 })); return;
    }
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/records/list')) {
      assert.equal(url.searchParams.get('operatorId'), 'operator-union');
      assert.equal(url.searchParams.has('clientToken'), false);
      const conditions = JSON.parse(body).filter.conditions;
      assert.deepEqual(conditions.map((condition: {field: string}) => condition.field), ['开放性', '尽责性', '外向性', '宜人性', '神经质']);
      const records = [...remote.values()].map(row => ({ id: row.id, fields: JSON.parse(row.body).records[0].fields }))
        .filter(row => conditions.every((condition: {field: string; value: unknown[]}) => Number(row.fields[condition.field]) === condition.value[0]));
      res.end(JSON.stringify({ records, hasMore: false })); return;
    }
    assert.equal(url.pathname, '/v1.0/notable/bases/test-base/sheets/hERWDMS/records');
    assert.equal(url.searchParams.get('operatorId'), 'operator-union');
    assert.equal(req.headers['x-acs-dingtalk-access-token'], 'fake-private-token');
    const token = url.searchParams.get('clientToken')!;
    received.push({ token, fields: JSON.parse(body).records[0].fields });
    const duplicate = remote.has(token);
    if (!duplicate) remote.set(token, { id: `remote-${remote.size + 1}`, body });
    assert.equal(remote.get(token)!.body, body);
    // DingTalk committed the first insert but the service never received its response.
    if (received.length === 1) { res.destroy(); return; }
    if (duplicate) { res.statusCode = 400; res.end(JSON.stringify({ code: 'invalidRequest.duplicateClientToken' })); return; }
    res.end(JSON.stringify({ value: [{ id: remote.get(token)!.id }] }));
  });
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address(); assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  let current: { child: ReturnType<typeof spawn>; exited: Promise<unknown>; base: string } | undefined;
  let logs = '';
  async function start(operatorId: string) {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
      env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: filename, BASE_URL: '',
        DINGTALK_APP_KEY: 'fake-key', DINGTALK_APP_SECRET: 'fake-private-secret', DINGTALK_BASE_ID: 'test-base',
        DINGTALK_SHEET_ID_OR_NAME: 'hERWDMS', DINGTALK_OPERATOR_ID: operatorId, DINGTALK_TEST_API_ORIGIN: endpoint },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test server startup timeout')), 5000);
      child.stdout!.on('data', chunk => { const line = String(chunk); logs += line; const found = line.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) { clearTimeout(timer); resolve(found[0]); } });
      child.stderr!.on('data', chunk => { logs += String(chunk); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('test server exited')); });
    });
    current = { child, exited, base };
  }
  async function stop() { if (current) { current.child.kill('SIGTERM'); await current.exited; current = undefined; } }
  let db: DatabaseSync | undefined;
  async function waitFor(condition: () => boolean) {
    const end = Date.now() + 5000;
    while (!condition()) { if (Date.now() > end) throw new Error('delivery timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  const data = { submissionId: randomUUID(), answers: Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) };
  const submit = (payload = data) => fetch(current!.base + '/api/results', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://assessment.example.org' }, body: JSON.stringify(payload),
  });
  try {
    await start('');
    const first = await submit(); assert.equal(first.status, 201); const result = await first.json();
    db = new DatabaseSync(filename);
    assert.equal(tokens, 0); assert.equal(received.length, 0);
    const original = db.prepare('SELECT * FROM results').all();
    assert.equal(db.prepare('SELECT count(*) AS n FROM dingtalk_outbox').get()!.n, 1);
    await stop(); await start('operator-union');
    await waitFor(() => Number(db!.prepare('SELECT next_attempt_at FROM dingtalk_outbox').get()!.next_attempt_at) > 0);
    assert.equal(remote.size, 1);
    assert.equal(db.prepare('SELECT record_id FROM dingtalk_outbox').get()!.record_id, null);
    await stop(); db.exec('UPDATE dingtalk_outbox SET next_attempt_at = 0'); await start('operator-union');
    await waitFor(() => db!.prepare('SELECT record_id FROM dingtalk_outbox').get()!.record_id === 'remote-1');
    assert.equal(received.length, 2); assert.equal(received[0]!.token, received[1]!.token);
    assert.deepEqual(received[0]!.fields, received[1]!.fields);
    assert.deepEqual(received[0]!.fields.链接, { text: '查看测评结果', link: new URL(result.shareUrl, 'https://assessment.example.org').href });
    assert.equal(received[0]!.fields.写入时间, Date.parse(String(original[0]!.created_at)));
    for (const retry of await Promise.all(Array.from({ length: 8 }, () => submit()))) { assert.equal(retry.status, 201); assert.deepEqual(await retry.json(), result); }
    assert.equal(remote.size, 1); assert.deepEqual(db.prepare('SELECT * FROM results').all(), original);
    const independent = await submit({ ...data, submissionId: randomUUID() }); assert.equal(independent.status, 201);
    await waitFor(() => remote.size === 2 && Number(db!.prepare('SELECT count(*) AS n FROM dingtalk_outbox WHERE synced_at IS NOT NULL').get()!.n) === 2);
    const snapshot = db.prepare('SELECT * FROM dingtalk_outbox ORDER BY result_id').all();
    await fetch(current!.base + '/api/results/decode?token=' + result.id);
    assert.deepEqual(db.prepare('SELECT * FROM dingtalk_outbox ORDER BY result_id').all(), snapshot);
    assert.equal(db.prepare('SELECT count(*) AS n FROM results').get()!.n, 2);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(logs.includes('fake-private-secret'), false); assert.equal(logs.includes('fake-private-token'), false);
  } finally { db?.close(); await stop(); await new Promise<void>(resolve => mock.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
