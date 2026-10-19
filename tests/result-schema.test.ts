import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResultStore } from '../server/store.ts';
import { loadResultCipher } from '../server/result-cipher.ts';
import { ASSESSMENT, QUESTIONS, calculateAllScores, type Answers } from '../src/index.ts';

const columns = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
const expected = [0, 25, 50, 75, 100];
const domainValues = { O: 1, C: 2, E: 3, A: 4, N: 5 };
const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, q.keyed === '-' ? 6 - domainValues[q.domain] : domainValues[q.domain]])) as Answers;
const scores = calculateAllScores(answers);
const json = JSON.stringify({ assessmentId: ASSESSMENT.id, scores });
const created = '2026-10-15T01:00:00.000Z';
const updated = '2026-10-16T02:00:00.000Z';
const oldSchema = `CREATE TABLE results (id INTEGER PRIMARY KEY AUTOINCREMENT, result_json TEXT NOT NULL,
  result_link TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const receiptSchema = `CREATE TABLE submission_receipts (request_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
  result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE) WITHOUT ROWID`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-domain-columns-'));
  const filename = join(directory, 'test.sqlite');
  const cipher = loadResultCipher(filename);
  const result = cipher.encrypt(scores, ASSESSMENT.id);
  const db = new DatabaseSync(filename);
  db.exec(oldSchema);
  return { directory, filename, result, db };
}

test('saves five distinct display scores in their corresponding integer columns', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-five-scores-'));
  const filename = join(directory, 'test.sqlite');
  const store = createResultStore(filename);
  const db = new DatabaseSync(filename);
  try {
    store.create({ submissionId: randomUUID(), answers });
    const row = db.prepare('SELECT * FROM results').get()!;
    assert.deepEqual(columns.map(column => row[column]), expected);
    assert.equal('result_json' in row, false);
    for (const invalid of [null, -1, 101, 50.5, 'invalid']) {
      assert.throws(() => db.prepare('UPDATE results SET openness = ?').run(invalid));
    }
    assert.deepEqual(columns.map(column => db.prepare('SELECT * FROM results').get()![column]), expected);
  } finally { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migrates integer IDs and JSON scores while preserving receipts, links, timestamps and deleted ID high-water mark', () => {
  const { directory, filename, result, db } = fixture();
  const submissionId = randomUUID();
  const fingerprint = createHash('sha256').update(JSON.stringify({ assessmentId: ASSESSMENT.id, answers })).digest('hex');
  try {
    db.exec(receiptSchema);
    for (const id of [3, 8, 20]) db.prepare('INSERT INTO results VALUES (?, ?, ?, ?, ?)').run(id, json, result.shareUrl, created, updated);
    db.prepare('DELETE FROM results WHERE id = 20').run();
    db.prepare('INSERT INTO submission_receipts VALUES (?, ?, ?)').run(submissionId, fingerprint, 8);
    const receipt = db.prepare('SELECT * FROM submission_receipts').all();
    const key = readFileSync(filename + '.link-key');
    db.close();
    let store = createResultStore(filename);
    try {
      const reader = new DatabaseSync(filename);
      const rows = reader.prepare('SELECT * FROM results ORDER BY id').all();
      assert.deepEqual(rows.map(row => row.id), [3, 8]);
      for (const row of rows) {
        assert.deepEqual(columns.map(column => row[column]), expected);
        assert.equal(row.result_link, result.shareUrl);
        assert.equal(row.created_at, created);
        assert.equal(row.updated_at, updated);
      }
      assert.deepEqual(reader.prepare('SELECT * FROM submission_receipts').all(), receipt);
      assert.deepEqual(reader.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(reader.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.deepEqual(store.create({ submissionId, answers }), result);
      assert.equal(reader.prepare('SELECT count(*) AS n FROM results').get()!.n, 2);
      const backups = readdirSync(join(directory, 'backups')).filter(name => name.endsWith('.sqlite'));
      assert.equal(backups.length, 1);
      const backupFile = join(directory, 'backups', backups[0]!);
      const backup = new DatabaseSync(backupFile, { readOnly: true });
      assert.equal(backup.prepare('SELECT result_json FROM results WHERE id = 8').get()!.result_json, json);
      assert.deepEqual(backup.prepare('SELECT * FROM submission_receipts').all(), receipt);
      backup.close();
      assert.deepEqual(readFileSync(backupFile + '.link-key'), key);
      store.create({ submissionId: randomUUID(), answers });
      assert.deepEqual(reader.prepare('SELECT id FROM results ORDER BY id').all().map(row => row.id), [3, 8, 21]);
      reader.close();
      store.close();
      store = createResultStore(filename);
      assert.deepEqual(store.create({ submissionId, answers }), result);
      assert.equal(readdirSync(join(directory, 'backups')).filter(name => name.endsWith('.sqlite')).length, 1);
    } finally { store.close(); }
    assert.deepEqual(readFileSync(filename + '.link-key'), key);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('migration rolls back malformed JSON or missing/invalid domain scores without touching receipts', () => {
  for (const value of ['{', JSON.stringify({ scores: {} }), JSON.stringify({ scores: { ...scores, O: { score: 101 } } })]) {
    const { directory, filename, result, db } = fixture();
    try {
      db.exec(receiptSchema);
      db.prepare('INSERT INTO results VALUES (?, ?, ?, ?, ?)').run(7, value, result.shareUrl, created, updated);
      db.prepare('INSERT INTO submission_receipts VALUES (?, ?, ?)').run(randomUUID(), 'test', 7);
      const before = db.prepare('SELECT * FROM results').all();
      const receipts = db.prepare('SELECT * FROM submission_receipts').all();
      db.close();
      assert.throws(() => createResultStore(filename));
      const reader = new DatabaseSync(filename, { readOnly: true });
      assert.deepEqual(reader.prepare('SELECT * FROM results').all(), before);
      assert.deepEqual(reader.prepare('SELECT * FROM submission_receipts').all(), receipts);
      assert.equal(reader.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'results_next'").get()!.n, 0);
      reader.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('migration preserves autoincrement high-water mark for an emptied historical table', () => {
  const { directory, filename, result, db } = fixture();
  try {
    db.prepare('INSERT INTO results VALUES (?, ?, ?, ?, ?)').run(30, json, result.shareUrl, created, updated);
    db.exec('DELETE FROM results');
    db.close();
    const store = createResultStore(filename);
    try { store.create({ submissionId: randomUUID(), answers }); }
    finally { store.close(); }
    const reader = new DatabaseSync(filename, { readOnly: true });
    assert.equal(reader.prepare('SELECT id FROM results').get()!.id, 31);
    reader.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a foreign-key failure after replacing the parent table restores the old schema and every receipt', () => {
  const { directory, filename, result, db } = fixture();
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(receiptSchema);
    db.prepare('INSERT INTO results VALUES (?, ?, ?, ?, ?)').run(4, json, result.shareUrl, created, updated);
    db.prepare('INSERT INTO submission_receipts VALUES (?, ?, ?)').run(randomUUID(), 'test', 999);
    const original = db.prepare('SELECT * FROM results').all();
    const receipts = db.prepare('SELECT * FROM submission_receipts').all();
    db.close();
    assert.throws(() => createResultStore(filename), /回执关联异常/);
    const reader = new DatabaseSync(filename, { readOnly: true });
    assert.deepEqual(reader.prepare('SELECT * FROM results').all(), original);
    assert.deepEqual(reader.prepare('SELECT * FROM submission_receipts').all(), receipts);
    assert.ok(reader.prepare('PRAGMA table_info(results)').all().some(column => column.name === 'result_json'));
    reader.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
