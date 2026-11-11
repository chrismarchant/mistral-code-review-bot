import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MistralChat,
  MistralNoTextError,
  MistralTimeoutError,
  extractMessageText,
  parseModelJson,
  getRequestTimeoutMs,
} from '../dist/mistral.js';

const makeFetch = (content, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
      text: async () => (ok ? '' : 'upstream error'),
    };
  };
  return { calls, fetchImpl };
};

test('codeReview returns parsed reviews array from JSON mode response', async () => {
  const reviews = [
    { hunk_header: '@@ -1,2 +1,3 @@', lgtm: false, review_comment: 'bug here' },
    { hunk_header: '@@ -9,1 +10,1 @@', lgtm: true, review_comment: '' },
  ];
  const { calls, fetchImpl } = makeFetch(JSON.stringify({ reviews }));
  const chat = new MistralChat('test-key', fetchImpl);

  const patch = '@@ -1,2 +1,3 @@\n-a\n+b\n+c\n';
  const res = await chat.codeReview(patch);

  assert.deepEqual(res, reviews);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'mistral-large-latest');
  assert.equal(body.response_format.type, 'json_object');
  assert.ok(body.messages[0].content.includes(patch));
  assert.ok(body.messages[0].content.includes('"reviews"'));
});

test('codeReview honours MODEL env var', async () => {
  process.env.MODEL = 'codestral-latest';
  try {
    const { calls, fetchImpl } = makeFetch(JSON.stringify({ reviews: [] }));
    const chat = new MistralChat('k', fetchImpl);
    await chat.codeReview('@@ -1 +1 @@\n-a\n+b\n');
    assert.equal(JSON.parse(calls[0].init.body).model, 'codestral-latest');
  } finally {
    delete process.env.MODEL;
  }
});

test('codeReview falls back to raw text when JSON parsing fails', async () => {
  const { fetchImpl } = makeFetch('not json at all');
  const chat = new MistralChat('k', fetchImpl);
  const patch = '@@ -5,2 +5,2 @@\n-a\n+b\n';
  const res = await chat.codeReview(patch);
  assert.equal(res.lgtm, false);
  assert.equal(res.review_comment, 'not json at all');
  assert.equal(res.hunk_header, '@@ -5,2 +5,2 @@');
});

test('codeReview returns lgtm for empty patch without calling the API', async () => {
  const { calls, fetchImpl } = makeFetch('{}');
  const chat = new MistralChat('k', fetchImpl);
  const res = await chat.codeReview('');
  assert.deepEqual(res, { lgtm: true, review_comment: '' });
  assert.equal(calls.length, 0);
});

test('codeReview throws on API error', async () => {
  const { fetchImpl } = makeFetch('', { ok: false, status: 429 });
  const chat = new MistralChat('k', fetchImpl);
  await assert.rejects(() => chat.codeReview('@@ -1 +1 @@\n-a\n'), /429/);
});

test('constructor requires an API key', () => {
  assert.throws(() => new MistralChat(''));
});

const makeRawFetch = (message, finish_reason = 'stop') => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message, finish_reason }] }),
      text: async () => '',
    };
  };
  return { calls, fetchImpl };
};

test('extractMessageText keeps only text blocks of array content', () => {
  const content = [
    { type: 'thinking', thinking: [{ type: 'text', text: 'SECRET THOUGHTS' }], closed: true },
    { type: 'text', text: '{"reviews":' },
    { type: 'unknown', text: 'ignored' },
    { type: 'text', text: '[]}' },
  ];
  assert.equal(extractMessageText(content), '{"reviews":[]}');
  assert.equal(extractMessageText('plain'), 'plain');
  assert.equal(extractMessageText(null), '');
  assert.equal(extractMessageText({ type: 'text', text: 'x' }), '');
});

test('codeReview parses array content with thinking + text blocks', async () => {
  const reviews = [{ hunk_header: '@@ -1 +1 @@', lgtm: false, review_comment: 'fix' }];
  const { fetchImpl } = makeRawFetch({
    content: [
      { type: 'thinking', thinking: [{ type: 'text', text: 'internal reasoning' }], closed: true },
      { type: 'text', text: JSON.stringify({ reviews }) },
    ],
  });
  const chat = new MistralChat('k', fetchImpl);
  const res = await chat.codeReview('@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual(res, reviews);
  assert.ok(!JSON.stringify(res).includes('internal reasoning'));
});

test('codeReview raises MistralNoTextError for thinking-only array content', async () => {
  const { fetchImpl } = makeRawFetch(
    {
      content: [
        { type: 'thinking', thinking: [{ type: 'text', text: 'internal reasoning' }], closed: false },
      ],
    },
    'length'
  );
  const chat = new MistralChat('k', fetchImpl);
  await assert.rejects(
    () => chat.codeReview('@@ -1 +1 @@\n-a\n+b\n'),
    (err) => {
      assert.ok(err instanceof MistralNoTextError);
      assert.equal(err.finishReason, 'length');
      assert.equal(
        err.message,
        'Mistral returned no review text for this file (finish_reason=length)'
      );
      assert.ok(!err.message.includes('internal reasoning'));
      return true;
    }
  );
});

test('codeReview raises MistralNoTextError for empty content', async () => {
  const { fetchImpl } = makeRawFetch({ content: '' });
  const chat = new MistralChat('k', fetchImpl);
  await assert.rejects(() => chat.codeReview('@@ -1 +1 @@\n-a\n'), MistralNoTextError);
});

test('codeReview still accepts plain string content', async () => {
  const review = { lgtm: true, review_comment: '' };
  const { fetchImpl } = makeRawFetch({ content: JSON.stringify(review) });
  const chat = new MistralChat('k', fetchImpl);
  assert.deepEqual(await chat.codeReview('@@ -1 +1 @@\n-a\n+b\n'), review);
});

test('codeReview tolerates ```json fenced output and surrounding prose', async () => {
  const reviews = [{ hunk_header: '@@ -1 +1 @@', lgtm: false, review_comment: 'use "{" carefully }' }];
  for (const text of [
    '```json\n' + JSON.stringify({ reviews }) + '\n```',
    'Here is my review:\n' + JSON.stringify({ reviews }) + '\nHope this helps.',
  ]) {
    const { fetchImpl } = makeRawFetch({ content: [{ type: 'text', text }] });
    const chat = new MistralChat('k', fetchImpl);
    assert.deepEqual(await chat.codeReview('@@ -1 +1 @@\n-a\n+b\n'), reviews);
  }
});

test('parseModelJson returns undefined for non-JSON prose', () => {
  assert.equal(parseModelJson('looks fine to me {not json'), undefined);
  assert.deepEqual(parseModelJson('x {"a":{"b":1}} y {"c":2}'), { a: { b: 1 } });
});

test('codeReview marks non-JSON prose as a raw string review', async () => {
  const { fetchImpl } = makeRawFetch({
    content: [
      { type: 'thinking', thinking: [{ type: 'text', text: 'hidden' }] },
      { type: 'text', text: 'Consider renaming x.' },
    ],
  });
  const chat = new MistralChat('k', fetchImpl);
  const res = await chat.codeReview('@@ -5,2 +5,2 @@\n-a\n+b\n');
  assert.equal(res.raw, true);
  assert.equal(res.lgtm, false);
  assert.equal(typeof res.review_comment, 'string');
  assert.equal(res.review_comment, 'Consider renaming x.');
});

test('codeReview aborts after REQUEST_TIMEOUT_MS with a clear error', async () => {
  process.env.REQUEST_TIMEOUT_MS = '20';
  // AbortSignal.timeout uses an unref'd timer; a real fetch keeps the event
  // loop alive, this mock does not, so hold it open for the test.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    let sawSignal = false;
    const fetchImpl = (url, init) =>
      new Promise((_resolve, reject) => {
        sawSignal = init.signal instanceof AbortSignal;
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const chat = new MistralChat('k', fetchImpl);
    await assert.rejects(
      () => chat.codeReview('@@ -1 +1 @@\n-a\n'),
      (err) => {
        assert.ok(err instanceof MistralTimeoutError);
        assert.equal(err.message, 'Mistral request timed out after 20 ms');
        return true;
      }
    );
    assert.ok(sawSignal);
  } finally {
    clearTimeout(keepAlive);
    delete process.env.REQUEST_TIMEOUT_MS;
  }
});

test('getRequestTimeoutMs defaults to 120000 for missing or invalid values', () => {
  delete process.env.REQUEST_TIMEOUT_MS;
  assert.equal(getRequestTimeoutMs(), 120000);
  process.env.REQUEST_TIMEOUT_MS = 'abc';
  assert.equal(getRequestTimeoutMs(), 120000);
  process.env.REQUEST_TIMEOUT_MS = '5000';
  assert.equal(getRequestTimeoutMs(), 5000);
  delete process.env.REQUEST_TIMEOUT_MS;
});
