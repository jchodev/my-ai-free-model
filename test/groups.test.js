'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGroups, resolveModelName, groupNames } = require('../groups');

const routes = [
  { key: 'a', canonical: 'nemotron-3.5-bolt-e4b' },
  { key: 'b', canonical: 'qwen3.8-27b' },
  { key: 'c', canonical: 'north-mini-code' },
  { key: 'd', canonical: 'muse-glimmer-30b' },
];
const cfg = {
  _comment: 'ignored',
  fast: { match: ['bolt'] },
  coder: { match: ['code', 'QWEN3.8'] },
  empty: { match: ['nothing-matches'] },
};

test('groupNames skips _comment keys', () => assert.deepEqual(groupNames(cfg), ['fast', 'coder', 'empty']));

test('buildGroups: case-insensitive substring; a route may be in several groups', () => {
  const g = buildGroups(routes, cfg);
  assert.deepEqual(g.fast.map((r) => r.key), ['a']);
  assert.deepEqual(g.coder.map((r) => r.key), ['b', 'c']);
});

test('resolveModelName: whole pool, group, empty group fallback, unknown', () => {
  assert.equal(resolveModelName('free-model', routes, cfg).routes.length, 4);
  assert.deepEqual(resolveModelName('free-model-fast', routes, cfg).routes.map((r) => r.key), ['a']);
  const e = resolveModelName('free-model-empty', routes, cfg);
  assert.equal(e.fellBack, true); assert.equal(e.routes.length, 4);
  assert.equal(resolveModelName('free-model-nope', routes, cfg), null);
  assert.equal(resolveModelName('gpt-4', routes, cfg), null);
});
