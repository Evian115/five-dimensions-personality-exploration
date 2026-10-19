import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createResultStore } from '../server/store.ts';

for (const finishBody of [true, false]) {
  test(finishBody ? 'SIGTERM drains an in-flight submission and its response before closing SQLite' : 'shutdown deadline closes a stalled body without creating partial records', { timeout: 10000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bigfive-shutdown-'));
    const filename = join(directory, 'test.sqlite');
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('DINGTALK_')) delete env[name];
    const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
      env: { ...env, HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: filename, BASE_URL: '', SHUTDOWN_TIMEOUT_MS: finishBody ? '3000' : '400' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    const exited = once(child, 'exit');
    let connection: ReturnType<typeof request> | undefined;
    try {
      const base = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error('startup timeout')), 5000);
        child.stdout.on('data', chunk => {
          output += chunk;
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) { clearTimeout(timeout); resolve(match[0]); }
        });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('early exit')); });
      });
      const payload = { submissionId: randomUUID(), answers: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i + 1, 3])) };
      const body = JSON.stringify(payload), split = Math.floor(body.length / 2);
      connection = request(base + '/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
      const response = new Promise<{ status?: number; body: string }>((resolve, reject) => {
        connection!.on('response', res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject); });
        connection!.on('error', reject);
      });
      // The stalled-body case is expected to disconnect at the shutdown deadline.
      const outcome = response.then(value => ({ value }), error => ({ error }));
      connection.write(body.slice(0, split));
      await new Promise(resolve => setTimeout(resolve, 100));
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(child.exitCode, null, 'SQLite must remain open while the body is in flight');
      if (finishBody) connection.end(body.slice(split));
      const result = await outcome;
      const [code] = await exited; assert.equal(code, 0);
      const db = new DatabaseSync(filename, { readOnly: true });
      assert.equal(db.prepare('SELECT COUNT(*) n FROM results').get()!.n, finishBody ? 1 : 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM submission_receipts').get()!.n, finishBody ? 1 : 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'); db.close();
      if (finishBody) {
        assert.ok('value' in result); assert.equal(result.value.status, 201);
        const saved = JSON.parse(result.value.body);
        const restarted = createResultStore(filename);
        try { assert.equal(restarted.create(payload).id, saved.id); } finally { restarted.close(); }
        assert.doesNotMatch(errors, /关停等待超时|database is not open/);
      } else {
        assert.ok('error' in result); assert.match(errors, /关停等待超时/);
      }
    } finally {
      connection?.destroy();
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
