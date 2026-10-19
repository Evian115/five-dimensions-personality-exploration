import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createResultCipher } from '../server/result-cipher.ts';
import { ASSESSMENT, QUESTIONS, calculateAllScores, type Answers } from '../src/index.ts';
import { validateSavedResult } from '../src/result.ts';

const scores = calculateAllScores(Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) as Answers);
const valid = createResultCipher(randomBytes(32)).encrypt(scores, ASSESSMENT.id);

test('accepts complete saved results and historical supported inventories', () => {
  assert.equal(validateSavedResult(valid), valid);
  const cipher = createResultCipher(randomBytes(32));
  const legacyScores = Object.fromEntries(['O', 'C', 'E', 'A', 'N'].map(key => [key, { rawScore: 34, score: 60, level: 'medium' }])) as typeof scores;
  assert.doesNotThrow(() => validateSavedResult(cipher.encrypt(legacyScores, 'ipip-50-v1')));
});

test('rejects malformed success responses before a draft can be cleared', () => {
  for (const value of [null, {}, [], 'ok', { ...valid, scores: {} }, { ...valid, interpretations: {} },
    { ...valid, relativePath: '/assessment' }, { ...valid, shareUrl: 'javascript:alert(1)' },
    { ...valid, scores: { ...scores, O: { ...scores.O, score: 101 } } },
    { ...valid, interpretations: { ...valid.interpretations, O: { text: 'ok', facets: [null] } } }]) {
    assert.throws(() => validateSavedResult(value), /答案已保留/);
  }
});
