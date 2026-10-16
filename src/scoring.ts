/** Mean-based scoring follows @bigfive-org/score@1.2.2 for the selected inventory. Reverse keys are applied once,
 * before summation, just as bigfive-web's keyed choices supply scores upstream.
 * Upstream level boundaries compare the unrounded mean with 3. The 0–100 value
 * is a display conversion of the 1–5 mean, not a population percentile.
 */
import { QUESTIONS, type Domain } from './data/questions.ts';
export type Level = 'low' | 'medium' | 'high';
export type Answers = Record<number, 1 | 2 | 3 | 4 | 5>;
export interface FacetScore { facet: number; score: number; rawScore: number; count: number; level: Level; }
export interface DomainScore { score: number; rawScore: number; count?: number; level: Level; facets?: FacetScore[]; }
export type Scores = Record<Domain, DomainScore>;
export function reverseScore(value: number) { return 6 - value; }
export function normalizeScore(rawScore: number, count = QUESTIONS.length / 5) { return Math.max(0, Math.min(100, Math.round(((rawScore / count - 1) / 4) * 100))); }
export function getLevel(score: number): Level { return score < 50 ? 'low' : score > 50 ? 'high' : 'medium'; }
function levelFromRaw(raw: number, count: number): Level { const mean = raw / count; return mean < 3 ? 'low' : mean > 3 ? 'high' : 'medium'; }
function sum(answers: Answers, items: typeof QUESTIONS) {
  return items.reduce((total, q) => { const value = answers[q.id]; return total + (value === undefined ? 0 : q.keyed === '-' ? reverseScore(value) : value); }, 0);
}
export function calculateDomainRawScore(answers: Answers, domain: Domain) { return sum(answers, QUESTIONS.filter(q => q.domain === domain)); }
export function calculateDomainScore(answers: Answers, domain: Domain): DomainScore {
  const items = QUESTIONS.filter(q => q.domain === domain);
  const rawScore = sum(answers, items);
  const count = items.length;
  const facets = Array.from({ length: 6 }, (_, index) => {
    const facet = index + 1;
    const subset = items.filter(q => q.facet === facet);
    const raw = sum(answers, subset);
    return { facet, rawScore: raw, count: subset.length, score: normalizeScore(raw, subset.length), level: levelFromRaw(raw, subset.length) };
  });
  return { rawScore, count, score: normalizeScore(rawScore, count), level: levelFromRaw(rawScore, count), facets };
}
export function calculateAllScores(answers: Answers): Scores { return Object.fromEntries((['E', 'A', 'C', 'N', 'O'] as Domain[]).map(domain => [domain, calculateDomainScore(answers, domain)])) as Scores; }
export function isValidAnswer(value: unknown): value is 1 | 2 | 3 | 4 | 5 { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5; }
export function isTestComplete(answers: Answers) { return QUESTIONS.every(q => isValidAnswer(answers[q.id])) && Object.keys(answers).length === QUESTIONS.length; }
export function getUnansweredCount(answers: Answers) { return QUESTIONS.filter(q => !isValidAnswer(answers[q.id])).length; }
export function getCompletionPercentage(answers: Answers) { return Math.round((QUESTIONS.length - getUnansweredCount(answers)) / QUESTIONS.length * 100); }
