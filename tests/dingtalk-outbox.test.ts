import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResultStore } from '../server/store.ts';
import { createDingtalkSynchronizer } from '../server/dingtalk-outbox.ts';
import { QUESTIONS } from '../src/index.ts';

const target = { baseId: 'base', sheetId: 'hERWDMS' };
const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, 3]));
const payload = () => ({ answers, submissionId: randomUUID() });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-dingtalk-outbox-'));
  const filename = join(directory, 'test.sqlite');
  let store = createResultStore(filename, '', target);
  const db = new DatabaseSync(filename);
  return { db, filename, get store() { return store; }, restart() { store.close(); store = createResultStore(filename, '', target); }, close() { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('a submission transaction saves one queue job with the same full share URL, while retries stay unchanged', () => {
  const f = setup();
  try {
    const data = payload();
    const result = f.store.create(data, 'https://example.com');
    const original = f.db.prepare('SELECT * FROM dingtalk_outbox').all();
    assert.equal(original.length, 1);
    assert.equal(original[0]!.client_token, data.submissionId);
    assert.equal(original[0]!.share_url, new URL(result.shareUrl, 'https://example.com').href);
    assert.equal(original[0]!.sheet_id, 'hERWDMS');
    assert.deepEqual(f.store.create(data, 'https://another.example'), result);
    assert.deepEqual(f.db.prepare('SELECT * FROM dingtalk_outbox').all(), original);
    f.store.create(payload(), 'https://example.com');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dingtalk_outbox').get()!.n, 2);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM results').get()!.n, 2);
  } finally { f.close(); }
});

test('failure to queue rolls back the result and receipt together', () => {
  const f = setup();
  try {
    f.db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON dingtalk_outbox BEGIN SELECT RAISE(ABORT, 'test'); END");
    assert.throws(() => f.store.create(payload(), 'https://example.com'));
    for (const table of ['results', 'submission_receipts', 'dingtalk_outbox']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
  } finally { f.close(); }
});

test('jobs and leases survive restart, use backoff, and ignore late acknowledgements from expired leases', () => {
  const f = setup();
  try {
    f.store.create(payload(), 'https://example.com');
    const first = f.store.outbox.claim(0)!;
    assert.ok(first);
    assert.equal(f.store.outbox.claim(1), undefined);
    f.restart();
    assert.equal(f.store.outbox.claim(100), undefined);
    const next = f.store.outbox.claim(60001)!;
    assert.notEqual(next.lease_token, first.lease_token);
    f.store.outbox.delivered(first, 'late-record', 60002);
    assert.equal(f.db.prepare('SELECT synced_at FROM dingtalk_outbox').get()!.synced_at, null);
    f.store.outbox.failed(next, 'NetworkOrTimeout', 60003);
    assert.equal(f.store.outbox.claim(60004), undefined);
    const retry = f.store.outbox.claim(90000)!;
    assert.equal(retry.client_token, first.client_token);
    f.store.outbox.delivered(retry, 'remote-record', 90001);
    f.restart();
    assert.equal(f.store.outbox.claim(999999), undefined);
    assert.equal(f.db.prepare('SELECT record_id FROM dingtalk_outbox').get()!.record_id, 'remote-record');
  } finally { f.close(); }
});

test('background delivery updates only technical queue state, preserving result scores and original timestamps', async () => {
  const f = setup(); let worker: ReturnType<typeof createDingtalkSynchronizer> | undefined;
  try {
    f.store.create(payload(), 'https://example.com');
    const original = f.db.prepare('SELECT * FROM results').all();
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) f.db.exec(`CREATE TRIGGER forbid_${operation} BEFORE ${operation} ON results BEGIN SELECT RAISE(ABORT, 'business write forbidden'); END`);
    let complete!: () => void;
    const delivered = new Promise<void>(resolve => { complete = resolve; });
    worker = createDingtalkSynchronizer(f.store.outbox, { async insert(job) { assert.equal(job.openness, 50); complete(); return 'remote-id'; } }, { pollMs: 10 });
    worker.wake();
    await Promise.race([delivered, new Promise((_, reject) => setTimeout(() => reject(new Error('worker timeout')), 2000))]);
    await worker.stop();
    assert.deepEqual(f.db.prepare('SELECT * FROM results').all(), original);
    assert.equal(f.db.prepare('SELECT record_id FROM dingtalk_outbox').get()!.record_id, 'remote-id');
  } finally { await worker?.stop(); f.close(); }
});


test('two server connections claim different jobs and cannot deliver an already leased job', () => {
  const f = setup();
  const other = createResultStore(f.filename, '', target);
  try {
    f.store.create(payload(), 'https://example.com');
    f.store.create(payload(), 'https://example.com');
    const first = f.store.outbox.claim(1)!;
    const second = other.outbox.claim(1)!;
    assert.notEqual(first.result_id, second.result_id);
    assert.equal(other.outbox.claim(2), undefined);
    assert.equal(f.store.outbox.claim(2), undefined);
  } finally { other.close(); f.close(); }
});
