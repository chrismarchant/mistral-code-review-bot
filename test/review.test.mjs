import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewFiles,
  sanitizeReviewComments,
  sanitizeReviewBody,
  createReviewBody,
} from '../dist/bot.js';
import { MistralNoTextError, MistralTimeoutError } from '../dist/mistral.js';

const patchA = '@@ -1,2 +1,3 @@\n-a\n+b\n+c\n';
const patchB = '@@ -10,1 +10,1 @@\n-x\n+y\n';
const patchC = '@@ -3 +3 @@\n-p\n+q\n';

test('sanitizeReviewComments drops non-string and empty bodies', () => {
  const good = { path: 'a.ts', body: 'ok', line: 3, side: 'RIGHT' };
  const out = sanitizeReviewComments([
    good,
    { path: 'a.ts', body: [{ type: 'text', text: 'x' }], line: 3, side: 'RIGHT' },
    { path: 'a.ts', body: { text: 'x' }, line: 3, side: 'RIGHT' },
    { path: 'a.ts', body: '   ', line: 3, side: 'RIGHT' },
    { path: 'a.ts', body: 'ok', line: 0, side: 'RIGHT' },
    null,
  ]);
  assert.deepEqual(out, [good]);
});

test('sanitizeReviewBody always returns a non-empty string', () => {
  assert.equal(sanitizeReviewBody('hello'), 'hello');
  for (const bad of [undefined, null, '', [{ type: 'text', text: 'x' }], 42]) {
    const body = sanitizeReviewBody(bad);
    assert.equal(typeof body, 'string');
    assert.ok(body.trim().length > 0);
  }
});

test('reviewFiles keeps other files when one file fails', async () => {
  const chat = {
    codeReview: async (patch) => {
      if (patch === patchA) {
        return [{ hunk_header: '@@ -1,2 +1,3 @@', lgtm: false, review_comment: 'issue in a' }];
      }
      if (patch === patchB) {
        throw new MistralTimeoutError(120000);
      }
      throw new MistralNoTextError('length');
    },
  };
  const result = await reviewFiles(chat, [
    { filename: 'a.ts', status: 'modified', patch: patchA },
    { filename: 'b.ts', status: 'modified', patch: patchB },
    { filename: 'c.ts', status: 'added', patch: patchC },
    { filename: 'gone.ts', status: 'removed', patch: patchC },
  ]);
  assert.equal(result.attempted, 3);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.comments, [
    { path: 'a.ts', body: 'issue in a', line: 3, side: 'RIGHT' },
  ]);
  assert.deepEqual(result.fileNotes, [
    '`b.ts`: Mistral request timed out after 120000 ms',
    '`c.ts`: Mistral returned no review text for this file (finish_reason=length)',
  ]);
  const body = createReviewBody(true, result.bodyComments, result.fileNotes);
  assert.ok(body.startsWith('Code review by Mistral'));
  assert.ok(body.includes('**Files not reviewed:**'));
  assert.ok(body.includes('finish_reason=length'));
});

test('reviewFiles reports HTTP errors without the upstream body', async () => {
  const err = Object.assign(new Error('Mistral API request failed with status 500: raw upstream text'), {
    name: 'MistralHttpError',
    status: 500,
  });
  const chat = { codeReview: async () => { throw err; } };
  const result = await reviewFiles(chat, [{ filename: 'a.ts', status: 'modified', patch: patchA }]);
  assert.equal(result.failed, 1);
  assert.equal(result.attempted, 1);
  assert.deepEqual(result.fileNotes, ['`a.ts`: Mistral API request failed with status 500']);
});

test('reviewFiles posts raw (non-JSON) text as a general body comment', async () => {
  const chat = {
    codeReview: async () => ({
      lgtm: false,
      hunk_header: '@@ -1,2 +1,3 @@',
      review_comment: 'Consider renaming b.',
      raw: true,
    }),
  };
  const result = await reviewFiles(chat, [{ filename: 'a.ts', status: 'modified', patch: patchA }]);
  assert.deepEqual(result.comments, []);
  assert.deepEqual(result.bodyComments, ['**File:** `a.ts`\n\nConsider renaming b.']);
  assert.equal(result.failed, 0);
});

test('reviewFiles drops reviews whose comment is not a string', async () => {
  const chat = {
    codeReview: async () => [
      { hunk_header: '@@ -1,2 +1,3 @@', lgtm: false, review_comment: [{ type: 'text', text: 'x' }] },
      { hunk_header: 7, lgtm: false, review_comment: 'bad header' },
    ],
  };
  const result = await reviewFiles(chat, [{ filename: 'a.ts', status: 'modified', patch: patchA }]);
  assert.deepEqual(result.comments, []);
  assert.deepEqual(result.bodyComments, ['**File:** `a.ts`\n\nbad header']);
  assert.equal(result.failed, 0);
});

test('createReviewBody keeps LGTM heading when there is nothing to report', () => {
  assert.equal(createReviewBody(false, []), 'LGTM 👍\n\n<!-- mistral-code-review -->');
});
