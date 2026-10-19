import type { Scores } from './scoring.ts';
import type { Interpretations } from './interpretations.ts';

export interface SavedResult {
  id: string;
  scores: Scores;
  assessmentId: string;
  interpretations: Interpretations;
  relativePath: string;
  shareUrl: string;
}

import { RESULT_VERSIONS, assessmentCount } from './assessment-versions.ts';

/** Validate responses before navigation or deleting the pending submission. */
export function validateSavedResult(value: unknown): SavedResult {
  const invalid = () => { throw new Error('服务返回的结果不完整或格式不正确，答案已保留，请重新提交。'); };
  const record = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  if (!record(value) || typeof value.assessmentId !== 'string' || !RESULT_VERSIONS.some(id => id === value.assessmentId)
    || typeof value.id !== 'string' || !/^e1_[A-Za-z0-9_-]{40,100}$/.test(value.id)
    || value.relativePath !== `/results/view#${value.id}` || typeof value.shareUrl !== 'string'
    || !record(value.scores) || !record(value.interpretations)) return invalid();
  try {
    const url = new URL(value.shareUrl, 'http://localhost');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search
      || !url.pathname.endsWith('/results/view') || url.hash !== `#${value.id}`) return invalid();
  } catch { return invalid(); }
  const count = assessmentCount(value.assessmentId) / 5;
  const validScore = (score: unknown, n: number): score is Record<string, unknown> => record(score)
    && typeof score.rawScore === 'number' && Number.isInteger(score.rawScore) && score.rawScore >= n && score.rawScore <= n * 5
    && typeof score.score === 'number' && Number.isInteger(score.score) && score.score >= 0 && score.score <= 100
    && typeof score.level === 'string' && ['low', 'medium', 'high'].includes(score.level)
    && (score.count === undefined || score.count === n);
  for (const domain of ['O', 'C', 'E', 'A', 'N']) {
    const score = value.scores[domain];
    const explanation = value.interpretations[domain];
    if (!validScore(score, count) || !record(explanation) || typeof explanation.text !== 'string'
      || !Array.isArray(explanation.facets)) return invalid();
    if (count === 10) {
      if (explanation.facets.length || (score.facets !== undefined && (!Array.isArray(score.facets) || score.facets.length))) return invalid();
      continue;
    }
    if (!Array.isArray(score.facets) || score.facets.length !== 6 || explanation.facets.length !== 6) return invalid();
    for (let i = 0; i < 6; i++) {
      const facet = score.facets[i];
      const text = explanation.facets[i];
      if (!validScore(facet, count / 6) || facet.facet !== i + 1
        || !validScore(text, count / 6) || text.facet !== i + 1
        || typeof text.title !== 'string' || typeof text.text !== 'string') return invalid();
    }
  }
  return value as unknown as SavedResult;
}
