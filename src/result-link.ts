import { CURRENT_ASSESSMENT_ID, RESULT_VERSIONS } from './assessment-versions.ts';
import { buildInterpretations } from './interpretations.ts';
import { normalizeScore, type Scores, type Level } from './scoring.ts';
import type { SavedResult } from './result.ts';

const keys = ['O', 'C', 'E', 'A', 'N'] as const;
const levels: Level[] = ['low', 'medium', 'high'];
export function encodeResult(scores: Scores, assessmentId: string): string {
  const data = [assessmentId, keys.map(key => {
    const d = scores[key];
    return [d.rawScore, d.score, levels.indexOf(d.level), d.facets?.map(f => f.rawScore) ?? []];
  })];
  return btoa(JSON.stringify(data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeResult(token: string, base = ''): SavedResult {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) throw new Error('结果链接格式不正确。');
  const data = JSON.parse(atob(token.replaceAll('-', '+').replaceAll('_', '/')));
  if (!Array.isArray(data) || data.length !== 2) throw new Error('结果链接格式不正确。');
  const [assessmentId, rows] = data;
  if (!RESULT_VERSIONS.includes(assessmentId) || !Array.isArray(rows) || rows.length !== 5) throw new Error('结果链接版本或数据不正确。');
  const legacy = assessmentId === 'ipip-50-v1';
  const facetCount = assessmentId === CURRENT_ASSESSMENT_ID ? 2 : 4;
  const domainCount = legacy ? 10 : facetCount * 6;
  const scores = Object.fromEntries(keys.map((key, i) => {
    const row = rows[i];
    if (!Array.isArray(row) || row.length !== 4) throw new Error('结果数据不完整。');
    const [rawScore, score, level, rawFacets] = row;
    if (!Number.isInteger(rawScore) || rawScore < domainCount || rawScore > (domainCount * 5) || !Number.isInteger(score) || score < 0 || score > 100 || !Number.isInteger(level) || !levels[level] || !Array.isArray(rawFacets) || rawFacets.length !== (legacy ? 0 : 6)) throw new Error('结果分数不正确。');
    const facets = rawFacets.map((raw: number, index: number) => {
      if (!Number.isInteger(raw) || raw < facetCount || raw > facetCount * 5) throw new Error('细分维度分数不正确。');
      return { facet: index + 1, rawScore: raw, count: facetCount, score: normalizeScore(raw, facetCount), level: (raw < facetCount * 3 ? 'low' : raw > facetCount * 3 ? 'high' : 'medium') as Level };
    });
    if (!legacy && (rawFacets.reduce((a: number, b: number) => a + b, 0) !== rawScore || normalizeScore(rawScore, domainCount) !== score || levels[level] !== (rawScore < domainCount * 3 ? 'low' : rawScore > domainCount * 3 ? 'high' : 'medium'))) throw new Error('结果分数不一致。');
    return [key, { rawScore, score, level: levels[level], ...(legacy ? {} : { count: domainCount, facets }) }];
  })) as Scores;
  const relativePath = `/results/view#${token}`;
  return { id: token, scores, assessmentId, interpretations: buildInterpretations(scores, legacy), relativePath, shareUrl: `${base}${relativePath}` };
}
