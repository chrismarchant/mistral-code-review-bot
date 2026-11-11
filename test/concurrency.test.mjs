import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Semaphore,
  splitPatchIntoChunks,
  reviewFilePatch,
} from '../dist/bot.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Semaphore caps concurrent executions and runs everything', async () => {
  const sem = new Semaphore(3);
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 10 }, (_, i) =>
    sem.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active--;
      return i;
    })
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(maxActive <= 3, `maxActive was ${maxActive}`);
  assert.equal(maxActive, 3, 'should reach the limit');
});

test('Semaphore propagates errors and releases the slot', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(() => sem.run(async () => { throw new Error('boom'); }));
  const v = await sem.run(async () => 42);
  assert.equal(v, 42);
});

const makePatch = (hunkCount) => {
  const lines = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
  ];
  for (let h = 0; h < hunkCount; h++) {
    const start = h * 10 + 1;
    lines.push(`@@ -${start},3 +${start},3 @@ hunk ${h}`);
    lines.push(' ctx');
    lines.push('-old');
    lines.push('+new');
  }
  return lines.join('\n');
};

test('splitPatchIntoChunks keeps small patches as one chunk', () => {
  const patch = makePatch(2);
  const chunks = splitPatchIntoChunks(patch, 200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], patch);
});

test('splitPatchIntoChunks splits large patches, preserving header and whole hunks', () => {
  const patch = makePatch(5); // each hunk = 4 lines
  const chunks = splitPatchIntoChunks(patch, 8); // 2 hunks per chunk
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.startsWith('diff --git a/src/a.ts b/src/a.ts'));
    assert.ok(chunk.includes('+++ b/src/a.ts'));
    assert.ok((chunk.match(/^@@/gm) || []).length >= 1);
  }
  // every hunk appears exactly once across chunks
  const allHunks = chunks.flatMap((c) => c.match(/^@@.*$/gm) || []);
  assert.equal(allHunks.length, 5);
});

test('splitPatchIntoChunks returns the input when there are no hunks', () => {
  assert.deepEqual(splitPatchIntoChunks('no hunks here'), ['no hunks here']);
  assert.deepEqual(splitPatchIntoChunks(''), ['']);
});

test('reviewFilePatch merges reviews across chunks and maps inline comments', async () => {
  const patch = makePatch(3); // 3 hunks, 4 lines each
  const hunkHeaders = patch.match(/^@@.*$/gm);

  let call = 0;
  const fakeChat = {
    codeReview: async (chunk) => {
      call++;
      const header = chunk.match(/^@@.*$/gm)[0];
      return [
        { hunk_header: header, lgtm: false, review_comment: `issue in ${header}` },
        { hunk_header: hunkHeaders[2], lgtm: true, review_comment: '' },
      ];
    },
  };

  const sem = new Semaphore(2);
  // 8 lines per chunk => 2 chunks for 3 hunks (4+4 lines each)
  const result = await reviewFilePatch(fakeChat, 'src/a.ts', patch, sem, 8);

  assert.ok(call >= 2, `expected chunked calls, got ${call}`);
  assert.ok(result.inline.length >= 2);
  for (const c of result.inline) {
    assert.equal(c.path, 'src/a.ts');
    assert.ok(c.line > 0);
    assert.ok(['RIGHT', 'LEFT'].includes(c.side));
  }
  assert.equal(result.body.length, 0);
});

test('reviewFilePatch falls back to body comment for unknown hunk headers', async () => {
  const patch = makePatch(1);
  const fakeChat = {
    codeReview: async () => [
      { hunk_header: '@@ -999,9 +999,9 @@', lgtm: false, review_comment: 'orphan review' },
    ],
  };
  const result = await reviewFilePatch(fakeChat, 'src/a.ts', patch, new Semaphore(1));
  assert.equal(result.inline.length, 0);
  assert.equal(result.body.length, 1);
  assert.ok(result.body[0].includes('orphan review'));
  assert.ok(result.body[0].includes('`src/a.ts`'));
});
