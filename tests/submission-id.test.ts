import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmissionId } from '../src/submission-id.ts';

test('uses native UUID generation when available', () => {
  const expected = '12345678-1234-4123-8123-123456789abc';
  assert.equal(createSubmissionId({
    randomUUID: () => expected,
    getRandomValues() { throw new Error('Native UUID should be used'); },
  }), expected);
});

test('LAN HTTP without randomUUID produces a valid UUID v4 using random bytes', () => {
  const random = {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      assert.ok(array instanceof Uint8Array);
      assert.equal(array.length, 16);
      array.fill(255);
      return array;
    },
  };
  assert.equal(createSubmissionId(random), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});
