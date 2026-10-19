import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { QUESTIONS, type Answers } from '../src/index.ts';
import { restoreDraft, saveDraft, completeDraft, draftPage, draftStorageKey, createDraftSession } from '../src/assessment-draft.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem(key: string) { return data.get(key) ?? null; },
    setItem(key: string, value: string) { data.set(key, value); },
    removeItem(key: string) { data.delete(key); },
  };
}
const answers = Object.fromEntries(QUESTIONS.map(q => [q.id, 3])) as Answers;

test('complete unsubmitted draft survives refresh with its submission ID and resumes at the last question', () => {
  const storage = memoryStorage();
  const original = { answers, submissionId: randomUUID() };
  saveDraft(storage, original);
  const refreshed = restoreDraft(storage);
  assert.deepEqual(refreshed, original);
  assert.equal(draftPage(refreshed.answers), QUESTIONS.length - 1);
  // A failed request does not change storage; another reload must retain the same identity.
  assert.deepEqual(restoreDraft(storage), original);
});

test('partial draft resumes at the first unanswered question', () => {
  const storage = memoryStorage();
  const partial = { ...answers };
  delete partial[QUESTIONS[17]!.id];
  saveDraft(storage, { answers: partial, submissionId: randomUUID() });
  const refreshed = restoreDraft(storage);
  assert.equal(Object.keys(refreshed.answers).length, QUESTIONS.length - 1);
  assert.equal(draftPage(refreshed.answers), 17);
});

test('migrates both partial and complete old answers-only drafts without losing answers', () => {
  for (const count of [QUESTIONS.length - 1, QUESTIONS.length]) {
    const storage = memoryStorage();
    const old = Object.fromEntries(QUESTIONS.slice(0, count).map(q => [q.id, 3]));
    storage.setItem(draftStorageKey, JSON.stringify(old));
    const migrated = restoreDraft(storage);
    assert.deepEqual(migrated.answers, old);
    assert.deepEqual(restoreDraft(storage), migrated);
  }
});

test('successful submission clears only its own draft, while explicitly starting over gets a new ID', () => {
  const storage = memoryStorage();
  const original = { answers, submissionId: randomUUID() };
  saveDraft(storage, original);
  completeDraft(storage, original.submissionId);
  assert.equal(storage.getItem(draftStorageKey), null);
  const fresh = restoreDraft(storage);
  assert.deepEqual(fresh.answers, {});
  assert.notEqual(fresh.submissionId, original.submissionId);
  saveDraft(storage, original);
  const restarted = restoreDraft(storage, true);
  assert.deepEqual(restarted.answers, {});
  assert.notEqual(restarted.submissionId, original.submissionId);
  completeDraft(storage, original.submissionId);
  assert.deepEqual(restoreDraft(storage), restarted);
});

test('malformed draft values and out-of-range answers are ignored', () => {
  for (const value of ['null', '{', '[]', '"text"', JSON.stringify({ answers: { 1: 6, 2: 2.5, 3: 4, 999: 3 }, submissionId: 'invalid' })]) {
    const storage = memoryStorage();
    storage.setItem(draftStorageKey, value);
    const restored = restoreDraft(storage);
    assert.match(restored.submissionId, /^[a-f0-9-]{36}$/);
    assert.ok(Object.keys(restored.answers).length <= 1);
    if (restored.answers[3]) assert.equal(restored.answers[3], 4);
  }
});


test('an older tab cannot overwrite a newer draft or submit its stale snapshot', () => {
  const storage = memoryStorage();
  const seed = { answers: Object.fromEntries(QUESTIONS.slice(0, 5).map(q => [q.id, 3])) as Answers, submissionId: randomUUID() };
  saveDraft(storage, seed);
  const oldTab = createDraftSession(storage);
  const newTab = createDraftSession(storage);
  const latest = { answers: Object.fromEntries(QUESTIONS.slice(0, 10).map(q => [q.id, 4])) as Answers, submissionId: randomUUID() };
  assert.equal(newTab.save(latest), true);
  const stored = storage.getItem(draftStorageKey);
  assert.equal(oldTab.save({ answers: { ...seed.answers, 6: 3 }, submissionId: randomUUID() }), false);
  assert.equal(storage.getItem(draftStorageKey), stored);
  assert.deepEqual(oldTab.draft, latest);
  assert.equal(draftPage(oldTab.draft.answers), 10);
  const updated = { answers: { ...latest.answers, 11: 2 as const }, submissionId: randomUUID() };
  assert.equal(oldTab.save(updated), true);
  assert.equal(newTab.save(latest), false);
  assert.deepEqual(newTab.draft, updated);
});

test('a late successful response never authorizes overwriting a newer tab draft', () => {
  const storage = memoryStorage();
  const old = createDraftSession(storage);
  const submitted = old.draft.submissionId;
  const newer = { answers: { 1: 5 as const }, submissionId: randomUUID() };
  saveDraft(storage, newer);
  old.complete(submitted);
  assert.equal(old.save({ answers: { 1: 1 }, submissionId: randomUUID() }), false);
  assert.deepEqual(old.draft, newer);
});

test('unavailable storage degrades to memory without throwing or losing current answers', () => {
  for (const mode of ['quota', 'blocked', 'missing']) {
    const broken = {
      getItem() { if (mode === 'blocked') throw new Error('SecurityError'); return null; },
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() { throw new Error('SecurityError'); },
    };
    const session = createDraftSession(mode === 'missing' ? undefined : broken);
    assert.equal(session.unavailable, true);
    const current = { answers, submissionId: randomUUID() };
    assert.equal(session.save(current), true);
    assert.deepEqual(session.draft, current);
    assert.doesNotThrow(() => session.complete(current.submissionId));
    assert.deepEqual(session.restart().answers, {});
  }
});
