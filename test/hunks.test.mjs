import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHunkHeader,
  getReviewCommentLocation,
  isHunkHeaderInPatch,
  createInlineReviewComment,
  createReviewBody,
  matchPatterns,
} from '../dist/bot.js';

const patch = [
  '@@ -10,5 +10,7 @@ function foo() {',
  ' context',
  '-old line',
  '+new line',
  '+another line',
  ' context',
  '@@ -30,3 +32,0 @@ function gone() {',
  '-a',
  '-b',
  '-c',
].join('\n');

test('parseHunkHeader parses standard header', () => {
  assert.deepEqual(parseHunkHeader('@@ -10,5 +10,7 @@ function foo() {'), {
    oldStart: 10,
    oldCount: 5,
    newStart: 10,
    newCount: 7,
  });
});

test('parseHunkHeader defaults missing counts to 1', () => {
  assert.deepEqual(parseHunkHeader('@@ -1 +1 @@'), {
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
  });
});

test('parseHunkHeader returns null for invalid input', () => {
  assert.equal(parseHunkHeader(undefined), null);
  assert.equal(parseHunkHeader('not a hunk'), null);
});

test('getReviewCommentLocation targets last added line on RIGHT', () => {
  assert.deepEqual(getReviewCommentLocation('@@ -10,5 +10,7 @@'), {
    line: 16,
    side: 'RIGHT',
  });
});

test('getReviewCommentLocation targets LEFT for pure deletions', () => {
  assert.deepEqual(getReviewCommentLocation('@@ -30,3 +32,0 @@'), {
    line: 32,
    side: 'LEFT',
  });
});

test('isHunkHeaderInPatch matches only headers present in the patch', () => {
  assert.equal(isHunkHeaderInPatch('@@ -10,5 +10,7 @@ function foo() {', patch), true);
  assert.equal(isHunkHeaderInPatch('@@ -99,9 +99,9 @@', patch), false);
  assert.equal(isHunkHeaderInPatch(undefined, patch), false);
});

test('createInlineReviewComment builds a comment for a valid hunk', () => {
  const comment = createInlineReviewComment(
    'src/a.ts',
    'this looks wrong',
    '@@ -10,5 +10,7 @@ function foo() {',
    patch
  );
  assert.deepEqual(comment, {
    path: 'src/a.ts',
    body: 'this looks wrong',
    line: 16,
    side: 'RIGHT',
  });
});

test('createInlineReviewComment returns null when hunk is not in patch', () => {
  assert.equal(
    createInlineReviewComment('src/a.ts', 'x', '@@ -1,1 +1,1 @@', patch),
    null
  );
  assert.equal(createInlineReviewComment('src/a.ts', 'x', undefined, patch), null);
});

test('createReviewBody uses LGTM when nothing to report', () => {
  assert.equal(
    createReviewBody(false, []),
    'LGTM 👍\n\n<!-- mistral-code-review -->'
  );
});

test('createReviewBody includes comments and marker', () => {
  const body = createReviewBody(true, ['**File:** `a.ts`\n\nnice catch']);
  assert.ok(body.startsWith('Code review by Mistral'));
  assert.ok(body.includes('**File:** `a.ts`'));
  assert.ok(body.endsWith('<!-- mistral-code-review -->'));
});

test('matchPatterns supports globs and regex-ish patterns', () => {
  assert.equal(matchPatterns(['*.md'], 'docs/readme.md'), true);
  assert.equal(matchPatterns(['*.md'], 'src/a.ts'), false);
  assert.equal(matchPatterns(['/node_modules/**/*'], '/x/node_modules/y/z.js'), true);
  assert.equal(matchPatterns(['*.md'], 'README.md'), true);
  assert.equal(matchPatterns(['src/**'], 'src/deep/a.ts'), true);
  assert.equal(matchPatterns(['src/**'], 'docs/a.ts'), false);
  assert.equal(matchPatterns([''], 'anything'), false);
});
