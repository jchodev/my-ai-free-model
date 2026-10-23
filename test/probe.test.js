'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeRoute } = require('../scripts/probe-chat');

const route = { provider: 'x', model: 'm', baseUrl: 'https://example.invalid/v1' };
const ok = (message, finish = 'stop') => ({ choices: [{ message, finish_reason: finish }] });

test('probeRoute: chat ok + tool call', async () => {
  let n = 0;
  const post = async () => (++n === 1 ? ok({ content: 'pong' }) : ok({ content: null, tool_calls: [{ id: '1' }] }, 'tool_calls'));
  const o = await probeRoute(route, 'k', post);
  assert.equal(o.chat, 'ok'); assert.equal(o.tools, 'yes');
});

test('probeRoute: thinking-only reply and no tool call are reported, not hidden', async () => {
  let n = 0;
  const post = async () => (++n === 1 ? ok({ content: '' }, 'length') : ok({ content: 'It is sunny' }));
  const o = await probeRoute(route, 'k', post);
  assert.equal(o.chat, 'ok(thinking-only)'); assert.equal(o.tools, 'no-call');
});

test('probeRoute: HTTP failure stops early and never leaks the key', async () => {
  const post = async (_u, headers) => {
    assert.equal(headers.Authorization, 'Bearer SECRET');
    const e = new Error('x'); e.status = 429; e.body = JSON.stringify({ error: { message: 'rate limited' } }); throw e;
  };
  const o = await probeRoute(route, 'SECRET', post);
  assert.match(o.chat, /^FAIL HTTP 429 rate limited/);
  assert.equal(o.tools, null);
  assert.ok(!JSON.stringify(o).includes('SECRET'));
});
