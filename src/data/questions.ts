// @bigfive-org/questions@1.3.3, MIT; see vendor/bigfive/questions/LICENSE.
import items from './ipip120.json' with { type: 'json' };
import { SELECTED_SOURCE_IDS } from './ipip60-selection.ts';
import { CURRENT_ASSESSMENT_ID } from '../assessment-versions.ts';

export type Domain = 'E' | 'A' | 'C' | 'N' | 'O';
export type Keyed = '+' | '-';
export interface Question { id: number; originalId?: number; sourceId: string; text: string; textEn: string; domain: Domain; facet: number; keyed: Keyed; }
export const ASSESSMENT = { id: CURRENT_ASSESSMENT_ID, name: 'IPIP 60题探索版', questionCount: 60, minutes: 5, source: '@bigfive-org/questions@1.3.3' } as const;
export const DOMAINS = {
  E: { code: 'E', name: 'Extraversion', description: 'Reflects sociability, assertiveness, and positive emotions' },
  A: { code: 'A', name: 'Agreeableness', description: 'Reflects cooperation, trust, and consideration for others' },
  C: { code: 'C', name: 'Conscientiousness', description: 'Reflects organization, dependability, and self-discipline' },
  N: { code: 'N', name: 'Neuroticism', description: 'Reflects emotional sensitivity and tendency to experience negative emotions' },
  O: { code: 'O', name: 'Openness', description: 'Reflects creativity, curiosity, and openness to new experiences' },
} as const;
export const FULL_QUESTIONS: Question[] = items as Question[];
const selected = new Set<number>(SELECTED_SOURCE_IDS);
// Keep the original interleaved domain order and spread matched items apart.
export const QUESTIONS: Question[] = FULL_QUESTIONS.filter(q => selected.has(q.id)).map((q, i) => ({ ...q, originalId: q.id, id: i + 1 }));
export const TOTAL_QUESTIONS = QUESTIONS.length;
export const DOMAIN_QUESTIONS = Object.fromEntries((Object.keys(DOMAINS) as Domain[]).map(domain => [domain, {
  plus: QUESTIONS.filter(q => q.domain === domain && q.keyed === '+').map(q => q.id),
  minus: QUESTIONS.filter(q => q.domain === domain && q.keyed === '-').map(q => q.id),
}])) as Record<Domain, { plus: number[]; minus: number[] }>;
export function getQuestionsByDomain(domain: Domain) { return QUESTIONS.filter(q => q.domain === domain); }
export function getQuestionById(id: number) { return QUESTIONS.find(q => q.id === id); }
