import { loadResultCipher } from '../server/result-cipher.ts';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ASSESSMENT, QUESTIONS, calculateAllScores, type Answers } from '../src/index.ts';
import { createResultStore } from '../server/store.ts';
import { decodeResult, encodeResult } from '../src/result-link.ts';

const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) as Answers;

test('result link round trips five domains and 30 facets without database or timestamps', () => {
  for (const values of [answers, Object.fromEntries(QUESTIONS.map(q => [q.id, Math.floor(Math.random() * 5) + 1])) as Answers]) {
    const scores = calculateAllScores(values);
    const token = encodeResult(scores, ASSESSMENT.id);
    const result = decodeResult(token);
    assert.deepEqual(result.scores, scores);
    assert.equal(Object.values(result.interpretations).flatMap(d => d.facets).length, 30);
    assert.equal('createdAt' in result, false);
    assert.equal(result.relativePath, `/results/view#${token}`);
    assert.ok(token.length < 600);
  }
  for (const token of ['', 'abc', 'x'.repeat(2049), btoa(JSON.stringify(['unknown', []])), btoa(JSON.stringify([ASSESSMENT.id, Array(5).fill([72, 50, 1, [4,4,4,4,4,4]])]))]) {
    assert.throws(() => decodeResult(token));
  }
});

test('database records identical submissions separately with autoincrement IDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-'));
  const filename = join(directory, 'test.sqlite');
  const store = createResultStore(filename, 'https://example.com/');
  try {
    const result = store.create({ submissionId: randomUUID(), answers });
    assert.equal(result.scores.O.score, 50);
    assert.equal(result.shareUrl, `https://example.com${result.relativePath}`);
    const second = store.create({ submissionId: randomUUID(), answers });
    const db = new DatabaseSync(filename);
    try {
      assert.deepEqual(db.prepare('PRAGMA table_info(results)').all().map(c => c.name), ['id', 'openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism', 'result_link', 'created_at', 'updated_at']);
      const rows = db.prepare('SELECT * FROM results ORDER BY id').all();
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(row => row.id), [1, 2]);
      assert.equal(rows[0]!.result_link, result.shareUrl);
      assert.equal(rows[1]!.result_link, second.shareUrl);
      for (const column of ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism']) assert.equal(rows[1]![column], rows[0]![column]);
      assert.equal(rows[0]!.created_at, rows[0]!.updated_at);
      assert.equal(rows[1]!.created_at, rows[1]!.updated_at);
      db.prepare('DELETE FROM results WHERE id = ?').run(2);
      store.create({ submissionId: randomUUID(), answers });
      assert.deepEqual(db.prepare('SELECT id FROM results ORDER BY id').all().map(row => row.id), [1, 3]);
      assert.deepEqual(['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'].map(column => rows[0]![column]), [50, 50, 50, 50, 50]);
      assert.ok(String(rows[0]!.updated_at) >= String(rows[0]!.created_at));
      assert.ok(Math.abs(Date.now() - Date.parse(String(rows[0]!.created_at))) < 5000);
    } finally { db.close(); }
    store.close();
    assert.deepEqual(store.decode(result.id).scores, result.scores);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('migration preserves legacy results and resolves old links without querying SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-legacy-'));
  const filename = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(filename);
  const scores = Object.fromEntries(['O','C','E','A','N'].map(key => [key, { score: 60, rawScore: 34, level: 'medium' }]));
  const id = randomUUID();
  db.exec('CREATE TABLE results (id TEXT PRIMARY KEY, submission_id TEXT UNIQUE, answers_json TEXT, scores_json TEXT, created_at TEXT)');
  db.prepare('INSERT INTO results VALUES (?, ?, ?, ?, ?)').run(id, randomUUID(), '{}', JSON.stringify(scores), '2026-10-15T00:00:00.000Z');
  db.close();
  let store = createResultStore(filename);
  try {
    store.close();
    store = createResultStore(filename);
    store.close();
    const result = store.get(id)!; // Closed DB proves compatibility resolution does not query it.
    assert.equal(result.assessmentId, 'ipip-50-v1');
    assert.deepEqual(result.scores, scores);
    assert.equal('createdAt' in result, false);
    const migratedDb = new DatabaseSync(filename, { readOnly: true });
    try {
      const link = String(migratedDb.prepare('SELECT result_link FROM results').get()!.result_link);
      assert.match(link, /#e1_/);
      assert.deepEqual(store.decode(link.split('#')[1]).scores, scores);
    } finally { migratedDb.close(); }
    assert.equal(store.get('missing'), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rejects incomplete, fractional, out-of-range answers and stale assessment', () => {
  const store = createResultStore(':memory:');
  try {
    for (const invalid of [{}, { ...answers, 1: undefined }, { ...answers, 1: 2.5 }, { ...answers, 1: 6 }, { ...answers, 121: 3 }]) {
      assert.throws(() => store.create({ submissionId: randomUUID(), answers: invalid }));
    }
    assert.throws(() => store.create({ submissionId: randomUUID(), answers, assessmentId: 'ipip-50-v1' }), /题库版本已更新/);
  } finally { store.close(); }
});


test('migrates the previous result-keyed table without losing data, links or timestamps', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-sequence-'));
  const filename = join(directory, 'test.sqlite');
  const json = JSON.stringify({ assessmentId: ASSESSMENT.id, scores: calculateAllScores(answers) });
  // An existing encrypted deployment also has its original persistent key.
  const link = loadResultCipher(filename).encrypt(calculateAllScores(answers), ASSESSMENT.id).shareUrl;
  const before = new DatabaseSync(filename);
  before.exec('CREATE TABLE results (result_json TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result_link TEXT NOT NULL)');
  before.prepare('INSERT INTO results VALUES (?, ?, ?, ?)').run(json, '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z', link);
  before.close();
  let store = createResultStore(filename);
  try {
    const backupFiles = readdirSync(join(directory, 'backups')).filter(name => name.endsWith('.sqlite'));
    assert.equal(backupFiles.length, 1);
    const backup = new DatabaseSync(join(directory, 'backups', backupFiles[0]!), { readOnly: true });
    try {
      const saved = backup.prepare('SELECT * FROM results').get()!;
      assert.equal(saved.result_json, json);
      assert.equal(saved.result_link, link);
      assert.equal(saved.created_at, '2026-10-15T00:00:00.000Z');
      assert.equal(saved.updated_at, '2026-10-16T00:00:00.000Z');
    } finally { backup.close(); }
    store.create({ submissionId: randomUUID(), answers });
    store.close();
    store = createResultStore(filename);
    store.create({ submissionId: randomUUID(), answers });
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const rows = db.prepare('SELECT * FROM results ORDER BY id').all();
      assert.deepEqual(rows.map(row => row.id), [1, 2, 3]);
      assert.ok(rows.every(row => row.openness === 50 && row.neuroticism === 50 && !('result_json' in row)));
      assert.deepEqual(rows[0], Object.assign(Object.create(null), { id: 1, openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50, result_link: link, created_at: '2026-10-15T00:00:00.000Z', updated_at: '2026-10-16T00:00:00.000Z' }));
      assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'results'").get()!.sql), /AUTOINCREMENT/);
    } finally { db.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('same submission retried after a lost response or restart returns the original link without changing records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-retry-'));
  const filename = join(directory, 'test.sqlite');
  let store = createResultStore(filename);
  const payload = { submissionId: randomUUID(), answers, assessmentId: ASSESSMENT.id };
  try {
    const first = store.create(payload);
    const reader = new DatabaseSync(filename, { readOnly: true });
    let original;
    try { original = reader.prepare('SELECT * FROM results').get(); }
    finally { reader.close(); }
    assert.deepEqual(store.create(payload), first);
    // A case-only UUID change still identifies the same request.
    assert.deepEqual(store.create({ ...payload, submissionId: payload.submissionId.toUpperCase() }), first);
    store.close();
    store = createResultStore(filename);
    assert.deepEqual(store.create(payload), first);
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT * FROM results').all(), [original]);
      assert.equal(db.prepare('SELECT count(*) AS count FROM submission_receipts').get()!.count, 1);
    } finally { db.close(); }
    // A genuinely separate assessment with identical scores must still create a new row.
    store.create({ ...payload, submissionId: randomUUID() });
    const after = new DatabaseSync(filename, { readOnly: true });
    try { assert.equal(after.prepare('SELECT count(*) AS count FROM results').get()!.count, 2); }
    finally { after.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('different answers cannot reuse the same submission ID, even when their scores match', () => {
  const store = createResultStore(':memory:');
  try {
    const payload = { submissionId: randomUUID(), answers };
    const first = store.create(payload);
    const pair = QUESTIONS.filter(q => q.domain === 'O' && q.facet === 1);
    assert.equal(pair.length, 2);
    assert.equal(pair[0]!.keyed, pair[1]!.keyed);
    const changed = { ...answers, [pair[0]!.id]: 2, [pair[1]!.id]: 4 } as Answers;
    assert.deepEqual(calculateAllScores(changed), calculateAllScores(answers));
    assert.throws(() => store.create({ ...payload, answers: changed }), error => (error as {status?: number}).status === 409);
    assert.deepEqual(store.create(payload), first);
  } finally { store.close(); }
});

test('receipt write failure rolls back the result row and permits a clean retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-atomic-'));
  const filename = join(directory, 'test.sqlite');
  const store = createResultStore(filename);
  const db = new DatabaseSync(filename);
  try {
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON submission_receipts BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const payload = { submissionId: randomUUID(), answers };
    assert.throws(() => store.create(payload));
    assert.equal(db.prepare('SELECT count(*) AS count FROM results').get()!.count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM submission_receipts').get()!.count, 0);
    db.exec('DROP TRIGGER fail_receipt');
    const result = store.create(payload);
    assert.deepEqual(store.create(payload), result);
    assert.equal(db.prepare('SELECT count(*) AS count FROM results').get()!.count, 1);
  } finally { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('decoding an encrypted link works after closing SQLite entirely', () => {
  const store = createResultStore(':memory:');
  const result = store.create({ submissionId: randomUUID(), answers });
  store.close();
  assert.deepEqual(store.decode(result.id), result);
});

test('normal startup preserves historical plaintext links without updating any submission rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-readonly-start-'));
  const filename = join(directory, 'test.sqlite');
  try {
    const store = createResultStore(filename);
    const result = store.create({ submissionId: randomUUID(), answers });
    store.close();
    const db = new DatabaseSync(filename);
    const legacy = encodeResult(result.scores, result.assessmentId);
    db.prepare('UPDATE results SET result_link = ?').run(`/results/view#${legacy}`);
    const snapshot = db.prepare('SELECT * FROM results').all();
    db.exec("CREATE TRIGGER forbid_startup_update BEFORE UPDATE ON results BEGIN SELECT RAISE(ABORT, 'startup must not update results'); END");
    db.close();
    const reopened = createResultStore(filename);
    try { assert.deepEqual(reopened.decode(legacy).scores, result.scores); }
    finally { reopened.close(); }
    const reader = new DatabaseSync(filename, { readOnly: true });
    try { assert.deepEqual(reader.prepare('SELECT * FROM results').all(), snapshot); }
    finally { reader.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
