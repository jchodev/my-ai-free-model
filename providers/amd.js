'use strict';
const { getModels, canonical } = require('../util');

const BASE = 'https://developer.amd.com.cn/radeon/api/v1';

// Every model in /v1/models reports free=false, so the free zone is an explicit allow-list
// (confirmed on the account page: "Free to use ... daily allowance 1.0 pts, RPM limit 20").
function select(data, { allow = [] } = {}) {
  const byId = new Map((data || []).map((m) => [m.id, m]));
  const routes = [];
  const skipped = [];
  const missing = [];
  for (const id of allow) {
    const m = byId.get(id);
    if (!m) { missing.push(id); continue; }
    const p = (m.providers && m.providers[0]) || {};
    if (!(m.output || []).includes('text')) { skipped.push({ model: id, reason: 'no text output' }); continue; }
    if (p.tools !== true) { skipped.push({ model: id, reason: 'no tool calling' }); continue; }
    routes.push({
      provider: 'amd', model: id, key: `amd:${id}`, canonical: canonical(id),
      ctx: m.context_length || null, maxOut: null, tools: true, vision: Boolean(p.vision),
      reasoning: Boolean(p.reasoning), router: false, expires: null, daysLeft: null,
      logsPrompts: null, baseUrl: BASE, apiKeyEnv: 'AMD_API_KEY',
      limits: { rpm: 20, dailyPoints: 1.0 },
    });
  }
  return { routes, skipped, missing };
}

async function discover(config) {
  if (!config.keys.amd && !config.fixtures.amd) {
    return { routes: [], skipped: [], disabled: true, notes: ['AMD_API_KEY not set — provider skipped'] };
  }
  const json = await getModels(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${config.keys.amd}` },
    timeoutMs: config.timeoutMs,
    fixture: config.fixtures.amd,
  });
  const { routes, skipped, missing } = select(json.data, { allow: (config.pool.amd || {}).allow });
  const notes = ['limits: 1.0 pt/day, 20 requests/min; daily reset 00:00 (account timezone)'];
  if (missing.length) notes.push(`allow-listed but not in provider list: ${missing.join(', ')}`);
  return { routes, skipped, notes };
}

module.exports = { name: 'amd', select, discover, BASE };
