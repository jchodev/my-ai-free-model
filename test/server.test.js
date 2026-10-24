'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { Router } = require('../router');

const R = (provider, model) => ({ provider, model, key: `${provider}:${model}`, canonical: model, ctx: 100000, tools: true, vision: false, baseUrl: `http://${provider}.test/v1` });
const ok = (text) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), { status: 200 });

async function run(fetchImpl, fn) {
  const router = new Router({ routes: [R('kilo', 'a'), R('nvidia', 'b')], groups: {} });
  const server = createServer({ config: { keys: { nvidia: 'k' }, firstByteMs: 500 }, router, fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, router); } finally { server.close(); }
}
const post = (base, body) => fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) });

test('lists free-model', async () => {
  await run(async () => ok('x'), async (base) => {
    const j = await (await fetch(`${base}/v1/models`)).json();
    assert.equal(j.data[0].id, 'free-model');
  });
});

test('fails over from 429 to next route and cools the first', async () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push([url, JSON.parse(init.body).model]);
    return url.includes('kilo') ? new Response('{"error":{"message":"slow"}}', { status: 429 }) : ok('hi');
  };
  await run(f, async (base, router) => {
    const r = await post(base, { model: 'free-model', messages: [{ role: 'user', content: 'yo' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-free-model-route'), 'nvidia:b');
    assert.equal((await r.json()).choices[0].message.content, 'hi');
    assert.match(router.status().routes[0].state, /^cooling/);
    assert.equal(calls[1][1], 'b'); // real upstream model id used
  });
});

test('all fail -> 503 with reasons; unknown model -> 404; video -> 400', async () => {
  await run(async () => new Response('boom', { status: 500 }), async (base) => {
    const r = await post(base, { model: 'free-model', messages: [] });
    assert.equal(r.status, 503); assert.match((await r.json()).error.message, /kilo:a.*nvidia:b/);
    assert.equal((await post(base, { model: 'gpt-4', messages: [] })).status, 404);
    assert.equal((await post(base, { messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] })).status, 400);
  });
});

test('streaming passes through, fails over before first byte', async () => {
  const sse = new Response('data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
  const f = async (url) => (url.includes('kilo') ? new Response('', { status: 503 }) : sse);
  await run(f, async (base) => {
    const r = await post(base, { stream: true, messages: [] });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /"A"[\s\S]*\[DONE\]/);
  });
});

test('OpenAPI spec and Swagger UI page', async () => {
  await run(async () => ok('x'), async (base) => {
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.equal(spec.openapi, '3.0.3');
    for (const p of ['/v1/models', '/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/status']) assert.ok(spec.paths[p], p);
    assert.deepEqual(spec.components.schemas.ChatRequest.properties.model.enum, ['free-model']);
    const html = await (await fetch(`${base}/docs`)).text();
    assert.match(html, /swagger-ui-bundle\.js/); assert.match(html, /\/openapi\.json/);
  });
});
