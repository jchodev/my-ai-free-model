'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../router');
const { classifyFailure, failureFromBody } = require('../failure');

const R = (provider, model, extra = {}) => ({
  provider, model, key: `${provider}:${model}`, canonical: extra.canonical || model.toLowerCase(),
  ctx: 100000, tools: true, vision: false, baseUrl: 'x', ...extra,
});
let clock;
const mk = (routes, groups) => { clock = 1_000_000; return new Router({ routes, groups, now: () => clock }); };
const keys = (plan) => plan.routes.map((r) => r.key);

test('classifyFailure', () => {
  assert.equal(classifyFailure({ timedOut: true }).kind, 'timeout');
  assert.equal(classifyFailure({ code: 'ECONNRESET' }).kind, 'network');
  assert.equal(classifyFailure({ status: 401 }).kind, 'auth');
  assert.equal(classifyFailure({ status: 404 }).kind, 'notfound');
  assert.equal(classifyFailure({ status: 429, body: '{"error":{"message":"free-models-per-day exceeded"}}' }).kind, 'daily');
  assert.equal(classifyFailure({ status: 429, body: 'slow down' }).kind, 'rate');
  assert.equal(classifyFailure({ status: 503, body: 'ResourceExhausted' }).kind, 'server');
  assert.equal(classifyFailure({ status: 400 }).kind, 'client');
  assert.equal(failureFromBody('data: {"error":{"code":429,"message":"x"}}').status, 429);
  assert.equal(failureFromBody('garbage').status, 502);
});

test('order: unknown latency uses provider order; learned latency wins', () => {
  const r = mk([R('amd', 'a'), R('kilo', 'k'), R('nvidia', 'n')]);
  assert.deepEqual(keys(r.plan('free-model')), ['kilo:k', 'nvidia:n', 'amd:a']);
  r.recordSuccess(r.routes[0], 5000); // amd slow
  r.recordSuccess(r.routes[2], 300);  // nvidia fast
  assert.deepEqual(keys(r.plan('free-model')), ['nvidia:n', 'kilo:k', 'amd:a']);
});

test('429 cools down 10 min, doubles on repeat, success resets', () => {
  const r = mk([R('amd', 'a'), R('nvidia', 'n')]);
  const [a] = r.routes;
  r.recordFailure(a, { kind: 'rate', status: 429, msg: '' });
  assert.deepEqual(keys(r.plan('free-model')), ['nvidia:n', 'amd:a']); // cooling goes last
  assert.equal(r.status().routes[0].state, 'cooling 600s');
  clock += 10 * 60000 + 1;
  assert.deepEqual(keys(r.plan('free-model')), ['nvidia:n', 'amd:a']); // healthy again, latency tie -> provider order
  r.recordFailure(a, { kind: 'rate', status: 429, msg: '' });
  r.recordFailure(a, { kind: 'rate', status: 429, msg: '' });
  assert.equal(r.status().routes[0].state, 'cooling 2400s'); // 10 * 2^2 min
  r.recordSuccess(a, 100);
  assert.equal(r.state.get(a.key).strikes, 0);
});

test('404 removes the route, 401 disables the provider', () => {
  const r = mk([R('amd', 'a'), R('amd', 'b'), R('nvidia', 'n')]);
  r.recordFailure(r.routes[0], { kind: 'notfound', status: 404, msg: '' });
  assert.deepEqual(keys(r.plan('free-model')), ['nvidia:n', 'amd:b']);
  r.recordFailure(r.routes[1], { kind: 'auth', status: 401, msg: '' });
  assert.deepEqual(keys(r.plan('free-model')), ['nvidia:n']);
  assert.match(r.status().providersDisabled.amd, /auth failed/);
});

test('rate limit is shared between kilo and openrouter siblings, 5xx is not', () => {
  const r = mk([R('kilo', 'x:free', { canonical: 'x' }), R('openrouter', 'x:free', { canonical: 'x' }), R('amd', 'y')]);
  r.recordFailure(r.routes[0], { kind: 'server', status: 503, msg: '' });
  assert.equal(r.status().routes[1].state, 'ok');
  r.recordFailure(r.routes[0], { kind: 'rate', status: 429, msg: '' });
  assert.match(r.status().routes[1].state, /^cooling/);
  assert.equal(r.status().routes[2].state, 'ok');
});

test('everything cooling: still returns the two that recover first', () => {
  const r = mk([R('kilo', 'a'), R('nvidia', 'b'), R('amd', 'c')]);
  r.recordFailure(r.routes[0], { kind: 'rate', status: 429, msg: '' });
  clock += 1000; r.recordFailure(r.routes[1], { kind: 'rate', status: 429, msg: '' });
  clock += 1000; r.recordFailure(r.routes[2], { kind: 'rate', status: 429, msg: '' });
  assert.deepEqual(keys(r.plan('free-model')), ['kilo:a', 'nvidia:b']);
});

test('context, tools and vision filters; group widening', () => {
  const groups = { coder: { match: ['code'] } };
  const r = mk([
    R('kilo', 'small', { ctx: 8000 }), R('nvidia', 'notools', { tools: false }),
    R('amd', 'vis', { vision: true, ctx: 200000 }), R('amd', 'north-mini-code'),
  ], groups);
  assert.equal(keys(r.plan('free-model', { promptTokens: 20000 })).length, 3);
  assert.ok(!keys(r.plan('free-model', { promptTokens: 20000 })).includes('kilo:small'));
  assert.ok(!keys(r.plan('free-model', { tools: true })).includes('nvidia:notools'));
  assert.deepEqual(keys(r.plan('free-model', { vision: true })), ['amd:vis']);
  const w = r.plan('free-model-coder', { vision: true });  // coder group has no vision route -> widen
  assert.equal(w.widened, true); assert.deepEqual(keys(w), ['amd:vis']);
});

test('unknown model -> 404 listing names; nothing fits -> 503', () => {
  const r = mk([R('kilo', 'a', { ctx: 1000 })], { fast: { match: ['a'] } });
  const e = r.plan('gpt-4').error;
  assert.equal(e.status, 404); assert.match(e.message, /free-model, free-model-fast/);
  assert.equal(r.plan('free-model', { promptTokens: 999999 }).error.status, 503);
});
