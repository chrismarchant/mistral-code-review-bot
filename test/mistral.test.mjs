import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MistralChat } from '../dist/mistral.js';

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
