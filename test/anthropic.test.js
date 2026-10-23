'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../anthropic');
const { createServer } = require('../server');
const { Router } = require('../router');

test('mapModel', () => {
  assert.equal(A.mapModel('claude-opus-4'), 'free-model-thinking');
  assert.equal(A.mapModel('claude-sonnet-5-5'), 'free-model-coder');
  assert.equal(A.mapModel('claude-haiku-4-5'), 'free-model-fast');
  assert.equal(A.mapModel('free-model-fast'), 'free-model-fast');
  assert.equal(A.mapModel('whatever'), 'free-model');
});

test('toOpenAI: system, tools, tool_use / tool_result, images', () => {
  const o = A.toOpenAI({
    model: 'free-model', max_tokens: 100, system: [{ type: 'text', text: 'S1' }, { type: 'text', text: 'S2' }],
    tools: [{ name: 'read', description: 'd', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'ws' }],
    tool_choice: { type: 'any' }, stop_sequences: ['X'],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'read', input: { p: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'FILE' }] }, { type: 'text', text: 'next' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] },
    ],
  });
  assert.equal(o.messages[0].content, 'S1\n\nS2');
  assert.equal(o.tools.length, 1);
  assert.equal(o.tool_choice, 'required');
  assert.deepEqual(o.stop, ['X']);
  assert.deepEqual(o.messages[2].tool_calls[0].function, { name: 'read', arguments: '{"p":1}' });
  assert.equal(o.messages[2].content, 'ok');
  assert.deepEqual(o.messages[3], { role: 'tool', tool_call_id: 't1', content: 'FILE' });
  assert.equal(o.messages[4].content[1].image_url.url, 'data:image/png;base64,AA');
});

test('toAnthropic: text, tool_calls, thinking only when enabled', () => {
  const j = { choices: [{ finish_reason: 'tool_calls', message: { content: 'x', reasoning_content: 'why', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"a":2}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 7 } };
  const a = A.toAnthropic(j, { model: 'm', thinking: false });
  assert.deepEqual(a.content.map((b) => b.type), ['text', 'tool_use']);
  assert.deepEqual(a.content[1].input, { a: 2 });
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.usage, { input_tokens: 5, output_tokens: 7 });
  assert.equal(A.toAnthropic(j, { model: 'm', thinking: true }).content[0].type, 'thinking');
});

const R = (provider, model) => ({ provider, model, key: `${provider}:${model}`, canonical: model, ctx: 100000, tools: true, vision: false, baseUrl: `http://${provider}.test/v1` });
async function run(fetchImpl, fn) {
  const router = new Router({ routes: [R('kilo', 'a'), R('nvidia', 'b')], groups: {} });
  const server = createServer({ config: { keys: {}, firstByteMs: 500 }, router, fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
const sse = (...objs) => new Response(objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join(''), { status: 200 });

test('/v1/messages non-stream with failover; count_tokens', async () => {
  const f = async (url) => (url.includes('kilo') ? new Response('x', { status: 429 })
    : new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 }));
  await run(f, async (base) => {
    const r = await post(base, '/v1/messages', { model: 'claude-haiku-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'yo' }] });
    const j = await r.json();
    assert.equal(r.status, 200); assert.equal(j.type, 'message'); assert.equal(j.content[0].text, 'hello'); assert.equal(j.stop_reason, 'end_turn');
    const c = await (await post(base, '/v1/messages/count_tokens', { messages: [{ role: 'user', content: 'hello world' }] })).json();
    assert.ok(c.input_tokens > 0);
    const e = await post(base, '/v1/messages', { model: 'x', messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] });
    assert.equal(e.status, 400); assert.equal((await e.json()).type, 'error');
  });
});

test('/v1/messages stream: text then tool call becomes Anthropic events', async () => {
  const f = async () => sse(
    { choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  );
  await run(f, async (base) => {
    const r = await post(base, '/v1/messages', { stream: true, max_tokens: 50, tools: [{ name: 'read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'go' }] });
    const t = await r.text();
    const types = [...t.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.match(t, /"text":"Hel"[\s\S]*"text":"lo"/);
    assert.match(t, /"partial_json":"\{\\"a\\""[\s\S]*"partial_json":":1\}"/);
    assert.match(t, /"stop_reason":"tool_use"/);
  });
});
