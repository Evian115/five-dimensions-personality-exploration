import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { QUESTIONS } from '../src/index.ts';

test('HTTP result decoding supports body-free GET and POST without adding database records', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-http-'));
  const filename = join(directory, 'test.sqlite');
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: filename, BASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
      child.stdout.on('data', chunk => {
        output += String(chunk);
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before starting')); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    for (const path of ['/test', '/test/', '/test/index.html']) {
      const redirect = await fetch(`${base}${path}?start=1&from=old`, { redirect: 'manual' });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get('location'), '/assessment?start=1&from=old');
    }
    const head = await fetch(`${base}/test?start=1`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 308);
    assert.equal(head.headers.get('location'), '/assessment?start=1');
    assert.equal(await head.text(), '');
    const payload = { submissionId: randomUUID(), answers: Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) };
    const submit = () => fetch(`${base}/api/results`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const created = await submit();
    assert.equal(created.status, 201);
    const result = await created.json();
    // Simulate a client missing the first successful response and retrying concurrently.
    const retries = await Promise.all(Array.from({ length: 8 }, submit));
    for (const retry of retries) {
      assert.equal(retry.status, 201);
      assert.deepEqual(await retry.json(), result);
    }
    const response = await fetch(`${base}/api/results/decode?token=${encodeURIComponent(result.id)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('transfer-encoding'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
    assert.deepEqual(JSON.parse(text), result);
    const post = await fetch(`${base}/api/results/decode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: result.id }),
    });
    assert.deepEqual(await post.json(), result);
    const invalid = await fetch(`${base}/api/results/decode?token=e1_invalid`);
    assert.equal(invalid.status, 400);
    assert.equal(typeof (await invalid.json()).error, 'string');
    const db = new DatabaseSync(filename, { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM results').get()!.count, 1); }
    finally { db.close(); }
  } finally {
    child.kill('SIGTERM');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
