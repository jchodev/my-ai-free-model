'use strict';
const { getModels, canonical } = require('../util');

const BASE = 'https://integrate.api.nvidia.com/v1';

// The NVIDIA list has no free flag and no metadata, so only allow-listed ids join the pool.
const NOT_CHAT = /(embed|rerank|retriev|ocr|speech|tts|asr|audio|guard|safety|reward|clip|deplot|kosmos|fuyu|parse|segment|detect|diffusion|flux|stable|vila|paligemma)/i;

function select(data, { allow = [] } = {}) {
  const ids = new Set((data || []).map((m) => m.id));
  const routes = [];
  const missing = [];
  for (const id of allow) {
    if (!ids.has(id)) { missing.push(id); continue; }
    routes.push({
      provider: 'nvidia', model: id, key: `nvidia:${id}`, canonical: canonical(id),
      ctx: null, maxOut: null, tools: null, vision: null, reasoning: null, router: false,
      expires: null, daysLeft: null, logsPrompts: null, baseUrl: BASE, apiKeyEnv: 'NVIDIA_API_KEY',
    });
  }
  const candidates = [...ids].filter((id) => !allow.includes(id) && !NOT_CHAT.test(id)).sort();
  return { routes, missing, candidates };
}

async function discover(config) {
  if (!config.keys.nvidia && !config.fixtures.nvidia) {
    return { routes: [], skipped: [], disabled: true, notes: ['NVIDIA_API_KEY not set — provider skipped'] };
  }
  const json = await getModels(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${config.keys.nvidia}` },
    timeoutMs: config.timeoutMs,
    fixture: config.fixtures.nvidia,
  });
  const { routes, missing, candidates } = select(json.data, { allow: (config.pool.nvidia || {}).allow });
  const notes = ['chat not yet verified (only the model list was tested)'];
  if (missing.length) notes.push(`allow-listed but not in provider list: ${missing.join(', ')}`);
  return { routes, skipped: [], notes, candidates };
}

module.exports = { name: 'nvidia', select, discover, BASE };
