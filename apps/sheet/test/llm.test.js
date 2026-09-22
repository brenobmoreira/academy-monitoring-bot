'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const props = { LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'key', LLM_MODEL: 'm' };
const ok = (obj) => ({ code: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });

test('extract posts an OpenAI-style request with json_schema and returns the parsed object', () => {
  const ctx = load({ properties: props, fetchResponses: [ok({ a: 1 })] });
  const out = ctx.LlmClient.extract({ system: 'S', user: 'U', schemaName: 'x', schema: { type: 'object' } });
  assert.deepEqual(plain(out), { a: 1 });
  const call = ctx.__fetchCalls[0];
  assert.equal(call.url, 'https://llm.example/v1/chat/completions');
  assert.equal(call.options.headers.Authorization, 'Bearer key');
  const body = JSON.parse(call.options.payload);
  assert.equal(body.model, 'm');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.messages[1].content, 'U');
});

test('extract tolerates fenced JSON and reports HTTP and JSON errors', () => {
  const fenced = { code: 200, body: JSON.stringify({ choices: [{ message: { content: '```json\n{"b":2}\n```' } }] }) };
  assert.deepEqual(plain(load({ properties: props, fetchResponses: [fenced] }).LlmClient.extract({ system: '', user: '', schemaName: 'x', schema: {} })), { b: 2 });
  assert.throws(() => load({ properties: props, fetchResponses: [{ code: 429, body: 'slow down' }] }).LlmClient.extract({ system: '', user: '', schemaName: 'x', schema: {} }), /LLM HTTP 429: slow down/);
  const junk = { code: 200, body: JSON.stringify({ choices: [{ message: { content: 'not json' } }] }) };
  assert.throws(() => load({ properties: props, fetchResponses: [junk] }).LlmClient.extract({ system: '', user: '', schemaName: 'x', schema: {} }), /non-JSON/);
  assert.throws(() => load({ properties: {} }).LlmClient.extract({}), /LLM not configured/);
});
