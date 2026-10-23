'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseEnv, getConfig, keyStatus } = require('../config');
const { canonical, expiryInfo, readFixture } = require('../util');
const kilo = require('../providers/kilo');
const openrouter = require('../providers/openrouter');
const nvidia = require('../providers/nvidia');
const amd = require('../providers/amd');
const { discoverAll } = require('../providers');

const fx = (n) => path.join(__dirname, 'fixtures', n);
const NOW = Date.parse('2026-10-23T12:00:00Z');

test('parseEnv: comments, quotes, inline comments, spaces', () => {
  const e = parseEnv('# c\nPORT=4570\nA="x y"\nB=\'z\'\nC=val # note\n# D=hidden\n  E = spaced  \nexport F=1\n');
  assert.deepEqual(e, { PORT: '4570', A: 'x y', B: 'z', C: 'val', E: 'spaced', F: '1' });
});

test('getConfig: process env wins, bad port falls back, keyStatus is boolean only', () => {
  const c = getConfig({ root: '/nonexistent', processEnv: { PORT: 'abc', NVIDIA_API_KEY: 'secret' } });
  assert.equal(c.port, 4570);
  assert.deepEqual(keyStatus(c), { openrouter: false, nvidia: true, amd: false });
  assert.ok(!JSON.stringify(keyStatus(c)).includes('secret'));
});

test('canonical: same model across gateways', () => {
  assert.equal(canonical('nvidia/nemotron-3.5-super-vl:free'), 'nemotron-3.5-super-vl');
  assert.equal(canonical('reflection/beam-free'), 'beam');
  assert.equal(canonical('DeepSeek-V4.1-Flash'), canonical('deepseek-ai/deepseek-v4.1-flash'));
});

test('expiryInfo: end of day UTC', () => {
  assert.equal(expiryInfo('2026-10-23', NOW).expired, false);
  assert.equal(expiryInfo('2026-10-22', NOW).expired, true);
  assert.equal(expiryInfo('2026-10-31', NOW).daysLeft, 9);
  assert.deepEqual(expiryInfo(undefined, NOW), { expires: null, expired: false, daysLeft: null });
});

test('kilo: keeps free+tools+text+unexpired, explains the rest', () => {
  const { routes, skipped } = kilo.select(readFixture(fx('kilo-small.json')).data, { deny: ['openrouter/free'], now: NOW });
  assert.deepEqual(routes.map((r) => r.model), [
    'kilo-auto/free', 'nvidia/nemotron-3.5-super-vl:free', 'poolside/laguna-s-2.1:free',
  ]);
  const reasons = Object.fromEntries(skipped.map((s) => [s.model, s.reason]));
  assert.equal(reasons['nvidia/nemotron-3.5-content-safety:free'], 'no tool calling');
  assert.match(reasons['poolside/old-model:free'], /^expired/);
  assert.match(reasons['openrouter/free'], /denied/);
  assert.ok(!('anthropic/paid-model' in reasons), 'non-free models are ignored silently');
  const auto = routes.find((r) => r.model === 'kilo-auto/free');
  assert.equal(auto.router, true);
  assert.equal(routes[1].vision, true);
  assert.equal(routes[1].logsPrompts, true);
  assert.equal(routes[2].daysLeft, 9);
});

test('openrouter: :free or zero price, never audio/denied/paid/router', () => {
  const { routes } = openrouter.select(readFixture(fx('openrouter-small.json')).data, { deny: ['openrouter/free'], now: NOW });
  assert.deepEqual(routes.map((r) => r.model), ['google/gemma-4-31b-it:free', 'vendor/zero-priced']);
});

test('nvidia: only allow-listed ids; reports missing and suggestions', () => {
  const r = nvidia.select(readFixture(fx('nvidia-small.json')).data, {
    allow: ['deepseek-ai/deepseek-v4.1-flash', 'google/gemma-4-31b-it', 'does/not-exist'],
  });
  assert.deepEqual(r.routes.map((x) => x.model), ['deepseek-ai/deepseek-v4.1-flash', 'google/gemma-4-31b-it']);
  assert.deepEqual(r.missing, ['does/not-exist']);
  assert.deepEqual(r.candidates, ['ibm/granite-3.0-8b-instruct']);
});

test('amd: allow-list + text + tools only (free flag is ignored)', () => {
  const r = amd.select(readFixture(fx('amd-small.json')).data, {
    allow: ['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'NoTools-Model', 'Clef', 'Gone-Model'],
  });
  assert.deepEqual(r.routes.map((x) => x.model), ['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash']);
  assert.deepEqual(r.skipped.map((s) => s.model).sort(), ['Clef', 'NoTools-Model']);
  assert.deepEqual(r.missing, ['Gone-Model']);
  assert.equal(r.routes[0].limits.rpm, 20);
});

test('discoverAll: providers without a key are skipped, one failure does not break the rest', async () => {
  const config = getConfig({
    root: path.join(__dirname, '..'),
    processEnv: {},
    dotenv: false, // tests must not depend on the real .env
    fixtures: { kilo: fx('kilo-small.json'), amd: fx('amd-small.json'), openrouter: fx('does-not-exist.json') },
  });
  config.keys.amd = 'k';
  const { routes, report } = await discoverAll(config, { now: NOW });
  const by = Object.fromEntries(report.map((r) => [r.provider, r]));
  assert.equal(by.kilo.ok, true);
  assert.equal(by.nvidia.disabled, true);
  assert.equal(by.openrouter.ok, false);          // fixture file missing -> error, isolated
  assert.ok(by.openrouter.error);
  assert.equal(by.amd.routes > 0, true);
  assert.ok(routes.every((r) => r.key === `${r.provider}:${r.model}`));
});
