import { ASSESSMENT, QUESTIONS, isValidAnswer, type Answers } from './index.ts';
import { createSubmissionId, isSubmissionId } from './submission-id.ts';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface AssessmentDraft { answers: Answers; submissionId: string; }
export const draftStorageKey = `bigfive-answers:${ASSESSMENT.id}`;

export function saveDraft(storage: DraftStorage, draft: AssessmentDraft) {
  storage.setItem(draftStorageKey, JSON.stringify(draft));
}

export function restoreDraft(storage: DraftStorage, startNew = false, createId = createSubmissionId): AssessmentDraft {
  if (startNew) storage.removeItem(draftStorageKey);
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(storage.getItem(draftStorageKey) || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* Ignore malformed drafts. */ }
  // Also migrate the previous answers-only localStorage format without losing complete drafts.
  const source = 'answers' in parsed ? parsed.answers : parsed;
  const answers: Answers = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const q of QUESTIONS) {
      const answer = (source as Record<string, unknown>)[q.id];
      if (isValidAnswer(answer)) answers[q.id] = answer;
    }
  }
  const draft = { answers, submissionId: isSubmissionId(parsed.submissionId) ? parsed.submissionId : createId() };
  saveDraft(storage, draft);
  return draft;
}

export function draftPage(answers: Answers) {
  const missing = QUESTIONS.findIndex(q => answers[q.id] === undefined);
  return missing < 0 ? QUESTIONS.length - 1 : missing;
}

export function completeDraft(storage: DraftStorage, submissionId: string) {
  // A response arriving in an older tab must not clear a different, newer draft.
  try {
    const stored: unknown = JSON.parse(storage.getItem(draftStorageKey) || 'null');
    if (stored && typeof stored === 'object' && 'submissionId' in stored && stored.submissionId === submissionId) {
      storage.removeItem(draftStorageKey);
    }
  } catch { /* A saved result stays successful even if localStorage is unavailable. */ }
}
