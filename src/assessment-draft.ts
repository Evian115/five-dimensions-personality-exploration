import { ASSESSMENT, QUESTIONS, isValidAnswer, type Answers } from './index.ts';
import { createSubmissionId, isSubmissionId } from './submission-id.ts';

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface AssessmentDraft { answers: Answers; submissionId: string; }
export const draftStorageKey = `bigfive-answers:${ASSESSMENT.id}`;

export function saveDraft(storage: DraftStorage, draft: AssessmentDraft) {
  try { storage.setItem(draftStorageKey, JSON.stringify(draft)); return true; }
  catch { return false; }
}

function parseDraft(serialized: string | null, createId = createSubmissionId): AssessmentDraft {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(serialized || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* Ignore malformed drafts. */ }
  // Also migrate the previous answers-only format, including complete drafts.
  const source = 'answers' in parsed ? parsed.answers : parsed;
  const answers: Answers = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const q of QUESTIONS) {
      const answer = (source as Record<string, unknown>)[q.id];
      if (isValidAnswer(answer)) answers[q.id] = answer;
    }
  }
  return { answers, submissionId: isSubmissionId(parsed.submissionId) ? parsed.submissionId : createId() };
}

export function restoreDraft(storage: DraftStorage, startNew = false, createId = createSubmissionId): AssessmentDraft {
  let serialized = null;
  try {
    if (startNew) storage.removeItem(draftStorageKey);
    else serialized = storage.getItem(draftStorageKey);
  } catch { /* Continue in memory when browser storage is disabled. */ }
  const draft = parseDraft(serialized, createId);
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

// Keep the exact snapshot this page read. Reject stale changes before writing or
// submitting; don't combine independent submissions or erase another tab's work.
export function createDraftSession(storage: DraftStorage | undefined, startNew = false) {
  let unavailable = !storage;
  let expected: string | null = null;
  function read() {
    if (!storage) return undefined;
    try { return storage.getItem(draftStorageKey); }
    catch { unavailable = true; return undefined; }
  }
  const original = read();
  expected = original ?? null;
  let current = parseDraft(startNew ? null : expected);
  function persist() {
    if (!storage) return;
    if (saveDraft(storage, current)) expected = JSON.stringify(current);
    else unavailable = true;
  }
  // Initialization must also detect another tab changing the draft while read.
  const latest = read();
  if (startNew || (original !== undefined && latest === original)) persist();
  else if (latest !== undefined) { expected = latest; current = parseDraft(latest); }
  return {
    get unavailable() { return unavailable; },
    get draft() { return current; },
    save(draft: AssessmentDraft) {
      const actual = read();
      if (actual !== undefined && actual !== expected) {
        current = parseDraft(actual);
        expected = actual;
        return false;
      }
      current = draft;
      if (actual !== undefined) persist();
      return true;
    },
    complete(id: string) {
      if (!storage) return;
      const before = read();
      completeDraft(storage, id);
      if (before === expected) { const after = read(); if (after !== undefined) expected = after; }
    },
    restart() { current = parseDraft(null); persist(); return current; },
  };
}
