'use strict';
const { getModels } = require('../util');
const { selectOrStyle } = require('./_orstyle');

const BASE = 'https://api.kilo.ai/api/gateway';

// Kilo's /models carries an explicit isFree flag.
function select(data, { deny = [], now } = {}) {
  return selectOrStyle(data, { provider: 'kilo', isFree: (m) => m.isFree === true, deny, now, baseUrl: BASE });
}

async function discover(config, { now = Date.now() } = {}) {
  const json = await getModels(`${BASE}/models`, { timeoutMs: config.timeoutMs, fixture: config.fixtures.kilo });
  const { routes, skipped } = select(json.data, { deny: (config.pool.kilo || {}).deny, now });
  return { routes, skipped, notes: ['no key needed', 'upstream may log prompts (mayTrainOnYourPrompts)'] };
}

module.exports = { name: 'kilo', select, discover, BASE };
