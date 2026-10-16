import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { ASSESSMENT, QUESTIONS, calculateAllScores, reverseScore, type Answers } from '../src/index.ts';
import { FULL_QUESTIONS } from '../src/data/questions.ts';
import { buildInterpretations } from '../src/interpretations.ts';
import originalQuestions from '../vendor/bigfive/questions/en.json' with { type: 'json' };
const require = createRequire(import.meta.url);
const upstream = require('../vendor/bigfive/score/index.cjs');

test('Chinese corrections preserve every upstream item and scoring assignment', () => {
  assert.equal(FULL_QUESTIONS.length, originalQuestions.length);
  for (const [index, source] of originalQuestions.entries()) {
    const question = FULL_QUESTIONS[index]!;
    assert.deepEqual(
      [question.id, question.sourceId, question.textEn, question.domain, question.facet, question.keyed],
      [index + 1, source.id, source.text, source.domain, source.facet, source.keyed === 'plus' ? '+' : '-'],
    );
  }
});

test('exploratory inventory has 60 questions, 12 per domain, 2 per facet', () => {
  assert.equal(QUESTIONS.length, 60);
  assert.equal(new Set(QUESTIONS.map(q => q.sourceId)).size, 60);
  for (const domain of ['O','C','E','A','N']) {
    const items = QUESTIONS.filter(q => q.domain === domain);
    assert.equal(items.length, 12);
    for (let facet = 1; facet <= 6; facet++) assert.equal(items.filter(q => q.facet === facet).length, 2);
  }
  assert.equal(ASSESSMENT.id, 'shiji-ipip60-exploratory-zh-v1');
});

test('scores and all 30 facet levels exactly match pinned upstream reducer', () => {
  for (let seed = 0; seed < 15; seed++) {
    const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, (q.id * (seed + 1) + seed * seed) % 5 + 1])) as Answers;
    const original = upstream({ answers: QUESTIONS.map(q => ({ domain: q.domain, facet: q.facet, score: q.keyed === '-' ? reverseScore(answers[q.id]!) : answers[q.id]! })) });
    const actual = calculateAllScores(answers);
    const report = buildInterpretations(actual);
    for (const domain of ['O','C','E','A','N'] as const) {
      const source = original[domain];
      assert.equal(actual[domain].rawScore, source.score);
      assert.equal(actual[domain].level, source.result === 'neutral' ? 'medium' : source.result);
      assert.equal(report[domain].facets.length, 6);
      assert.ok(report[domain].text.length > 15);
      for (const facet of actual[domain].facets!) {
        assert.equal(facet.rawScore, source.facet[facet.facet].score);
        assert.equal(facet.level, source.facet[facet.facet].result === 'neutral' ? 'medium' : source.facet[facet.facet].result);
        assert.ok(report[domain].facets[facet.facet - 1]!.text.length > 5);
      }
    }
  }
});

test('minimum and maximum responses honor item keying across all facets', () => {
  for (const high of [false, true]) {
    const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, (q.keyed === '+') === high ? 5 : 1])) as Answers;
    for (const score of Object.values(calculateAllScores(answers))) {
      assert.equal(score.rawScore, high ? 60 : 12);
      assert.equal(score.score, high ? 100 : 0);
      assert.ok(score.facets!.every(f => f.rawScore === (high ? 10 : 2)));
    }
  }
});


test('selection preserves source text and keys, balances available opposite keys, and renumbers continuously', () => {
  assert.deepEqual(QUESTIONS.map(q => q.id), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.equal(QUESTIONS.filter(q => q.keyed === '+').length, 31);
  assert.equal(QUESTIONS.filter(q => q.keyed === '-').length, 29);
  for (const q of QUESTIONS) {
    const source = FULL_QUESTIONS.find(original => original.id === q.originalId)!;
    assert.ok(source);
    for (const key of ['sourceId', 'text', 'textEn', 'domain', 'facet', 'keyed'] as const) assert.equal(q[key], source[key]);
  }
  for (const domain of ['O', 'C', 'E', 'A', 'N']) {
    for (let facet = 1; facet <= 6; facet++) {
      const available = FULL_QUESTIONS.filter(q => q.domain === domain && q.facet === facet);
      const chosen = QUESTIONS.filter(q => q.domain === domain && q.facet === facet);
      if (new Set(available.map(q => q.keyed)).size === 2) assert.equal(new Set(chosen.map(q => q.keyed)).size, 2);
    }
  }
});
