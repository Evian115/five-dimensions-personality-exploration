import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  calculateAllScores,
  calculateDomainRawScore,
  getLevel,
  normalizeScore,
  QUESTIONS,
  reverseScore,
  type Answers,
} from '../src/index.ts';

test('reverseScore maps 1→5, 3→3, 5→1', () => {
  assert.equal(reverseScore(1), 5);
  assert.equal(reverseScore(2), 4);
  assert.equal(reverseScore(3), 3);
  assert.equal(reverseScore(4), 2);
  assert.equal(reverseScore(5), 1);
});

test('normalizeScore maps 12-item raw 12→0, 36→50, 60→100', () => {
  assert.equal(normalizeScore(12), 0);
  assert.equal(normalizeScore(36), 50);
  assert.equal(normalizeScore(60), 100);
});

test('getLevel bands', () => {
  assert.equal(getLevel(0), 'low');
  assert.equal(getLevel(49), 'low');
  assert.equal(getLevel(50), 'medium');
  assert.equal(getLevel(51), 'high');
  assert.equal(getLevel(66), 'high');
  assert.equal(getLevel(100), 'high');
});

test('all-3 answers produce a neutral score of 50 across all domains', () => {
  const answers: Answers = {};
  for (const q of QUESTIONS) answers[q.id] = 3;
  const scores = calculateAllScores(answers);
  for (const domain of ['E', 'A', 'C', 'N', 'O'] as const) {
    assert.equal(scores[domain].score, 50, `${domain} should be 50`);
    assert.equal(scores[domain].level, 'medium');
  }
});

test('all-5 on plus items and all-1 on minus items maxes every domain', () => {
  const answers: Answers = {};
  for (const q of QUESTIONS) answers[q.id] = q.keyed === '+' ? 5 : 1;
  const scores = calculateAllScores(answers);
  for (const domain of ['E', 'A', 'C', 'N', 'O'] as const) {
    assert.equal(scores[domain].rawScore, 60);
    assert.equal(scores[domain].score, 100);
    assert.equal(scores[domain].level, 'high');
  }
});

test('Extraversion raw score reflects reverse-keying', () => {
  const answers: Answers = {};
  for (const q of QUESTIONS) answers[q.id] = 3;
  // E contains 12 items; midpoint answers sum to 36 after reverse-keying.
  assert.equal(calculateDomainRawScore(answers, 'E'), 36);
});


test('historical 24-item normalization remains unchanged when count is explicit', () => {
  assert.equal(normalizeScore(24, 24), 0);
  assert.equal(normalizeScore(72, 24), 50);
  assert.equal(normalizeScore(120, 24), 100);
});
