import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
