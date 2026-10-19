import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createResultStore } from '../server/store.ts';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSESSMENT, QUESTIONS, calculateAllScores, type Answers } from '../src/index.ts';
import { encodeResult } from '../src/result-link.ts';
import { createResultCipher, loadResultCipher } from '../server/result-cipher.ts';

const cipher = createResultCipher(randomBytes(32));
test('encrypted compact links preserve exact scores and all facets across versions', () => {
  for (const value of [1, 3, 5, 0]) {
    const answers = Object.fromEntries(QUESTIONS.map((q, i) => [q.id, value || i % 5 + 1])) as Answers;
    const scores = calculateAllScores(answers);
    for (const assessmentId of [ASSESSMENT.id, 'johnson-120-ipip-neo-pi-r-zh-v2', 'johnson-120-ipip-neo-pi-r']) {
      const expected = assessmentId === ASSESSMENT.id ? scores : Object.fromEntries(Object.entries(scores).map(([key, d]) => [key, {
        ...d, count: 24, rawScore: d.rawScore * 2, facets: d.facets!.map(f => ({ ...f, count: 4, rawScore: f.rawScore * 2 })),
      }])) as typeof scores;
      const encrypted = cipher.encrypt(expected, assessmentId);
      assert.equal(encrypted.id.length, assessmentId === ASSESSMENT.id ? 62 : 67);
      assert.match(encrypted.id, /^e1_[A-Za-z0-9_-]+$/);
      const decoded = cipher.decrypt(encrypted.id);
      assert.deepEqual(decoded.scores, expected);
      assert.equal(decoded.assessmentId, assessmentId);
      assert.equal(decoded.id, encrypted.id);
      assert.notEqual(cipher.encrypt(expected, assessmentId).id, encrypted.id);
    }
  }
});

test('legacy scores retain original levels and previous plaintext links upgrade', () => {
  const scores = Object.fromEntries(['O','C','E','A','N'].map(key => [key, { rawScore: 34, score: 60, level: 'medium' as const }])) as ReturnType<typeof calculateAllScores>;
  const result = cipher.decrypt(encodeResult(scores, 'ipip-50-v1'));
  assert.match(result.id, /^e1_/);
  assert.deepEqual(cipher.decrypt(result.id).scores, scores);
});

test('rejects tampering, truncation, invalid encoding, and incorrect keys', () => {
  const scores = calculateAllScores(Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) as Answers);
  const result = cipher.encrypt(scores, ASSESSMENT.id);
  const bytes = Buffer.from(result.id.slice(3), 'base64url');
  for (const index of [0, 12, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[index] = changed[index]! ^ 1;
    assert.throws(() => cipher.decrypt('e1_' + changed.toString('base64url')));
  }
  for (const token of ['', 'e1_abc', result.id.slice(0, -4), result.id + '=']) assert.throws(() => cipher.decrypt(token));
  assert.throws(() => createResultCipher(randomBytes(32)).decrypt(result.id));
});

test('encryption key persists across server restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-key-'));
  try {
    const filename = join(directory, 'test.sqlite');
    const first = loadResultCipher(filename);
    const scores = calculateAllScores(Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) as Answers);
    const result = first.encrypt(scores, ASSESSMENT.id);
    assert.deepEqual(loadResultCipher(filename).decrypt(result.id).scores, scores);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('missing key with existing encrypted records refuses startup without replacing key or changing data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-key-loss-'));
  const filename = join(directory, 'test.sqlite');
  try {
    let store = createResultStore(filename);
    const payload = { submissionId: randomUUID(), answers: Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) };
    const result = store.create(payload);
    store.close();
    const key = readFileSync(filename + '.link-key');
    const db = new DatabaseSync(filename, { readOnly: true });
    const snapshot = db.prepare('SELECT * FROM results').all();
    db.close();
    rmSync(filename + '.link-key');
    assert.throws(() => createResultStore(filename), /已有加密结果但缺少密钥/);
    assert.equal(existsSync(filename + '.link-key'), false);
    const after = new DatabaseSync(filename, { readOnly: true });
    assert.deepEqual(after.prepare('SELECT * FROM results').all(), snapshot);
    after.close();
    writeFileSync(filename + '.link-key', key, { mode: 0o600 });
    store = createResultStore(filename);
    try {
      assert.deepEqual(store.decode(result.id), result);
      assert.deepEqual(store.create(payload), result);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('empty databases can initialize a missing key on their first submission', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-key-empty-'));
  const filename = join(directory, 'test.sqlite');
  try {
    createResultStore(filename).close();
    rmSync(filename + '.link-key');
    const store = createResultStore(filename);
    try { assert.equal(readFileSync(filename + '.link-key').length, 32); }
    finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a different 32-byte key refuses startup without changing records, and restoring the original key recovers retries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-key-mismatch-'));
  const filename = join(directory, 'test.sqlite');
  try {
    let store = createResultStore(filename);
    const payload = { submissionId: randomUUID(), answers: Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) };
    const result = store.create(payload);
    store.close();
    const original = readFileSync(filename + '.link-key');
    const db = new DatabaseSync(filename, { readOnly: true });
    const before = db.prepare('SELECT * FROM results').all();
    db.close();
    const wrong = randomBytes(32);
    writeFileSync(filename + '.link-key', wrong);
    assert.throws(() => createResultStore(filename), /密钥与已有加密结果不匹配/);
    assert.deepEqual(readFileSync(filename + '.link-key'), wrong);
    const after = new DatabaseSync(filename, { readOnly: true });
    assert.deepEqual(after.prepare('SELECT * FROM results').all(), before);
    assert.equal(after.prepare('SELECT COUNT(*) n FROM submission_receipts').get()!.n, 1);
    after.close();
    writeFileSync(filename + '.link-key', original);
    store = createResultStore(filename);
    try { assert.deepEqual(store.create(payload), result); assert.deepEqual(store.decode(result.id), result); }
    finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('startup checks later records too, rejecting databases containing a second encryption key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bigfive-mixed-keys-'));
  const filename = join(directory, 'test.sqlite');
  try {
    const store = createResultStore(filename);
    const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) as Answers;
    store.create({ submissionId: randomUUID(), answers });
    store.create({ submissionId: randomUUID(), answers });
    store.close();
    const different = createResultCipher(randomBytes(32)).encrypt(calculateAllScores(answers), ASSESSMENT.id);
    const db = new DatabaseSync(filename);
    db.prepare('UPDATE results SET result_link = ? WHERE id = 2').run(different.shareUrl);
    db.close();
    assert.throws(() => createResultStore(filename), /密钥与已有加密结果不匹配/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
