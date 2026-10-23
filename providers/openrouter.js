'use strict';
const { getModels } = require('../util');
const { selectOrStyle } = require('./_orstyle');

const BASE = 'https://openrouter.ai/api/v1';

const zero = (v) => v !== undefined && v !== null && v !== '' && Number(v) === 0;

// Free = ":free" id, or zero prompt + completion price.
function isFree(m) {
  if (String(m.id).endsWith(':free')) return true;
  const p = m.pricing || {};
  return zero(p.prompt) && zero(p.completion);
}

function select(data, { deny = [], now } = {}) {
  return selectOrStyle(data, { provider: 'openrouter', isFree, deny, now, baseUrl: BASE, apiKeyEnv: 'OPENROUTER_API_KEY' });
}

async function discover(config, { now = Date.now() } = {}) {
  if (!config.keys.openrouter && !config.fixtures.openrouter) {
    return { routes: [], skipped: [], disabled: true, notes: ['OPENROUTER_API_KEY not set — provider skipped'] };
  }
  const json = await getModels(`${BASE}/models`, { timeoutMs: config.timeoutMs, fixture: config.fixtures.openrouter });
  const { routes, skipped } = select(json.data, { deny: (config.pool.openrouter || {}).deny, now });
  return { routes, skipped, notes: ['free models are capped per day (about 50/day without credits; not re-tested)'] };
}

module.exports = { name: 'openrouter', select, discover, isFree, BASE };
