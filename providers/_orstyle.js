'use strict';
// Shared filter for OpenRouter-style model lists (Kilo uses the same schema).
const { canonical, expiryInfo } = require('../util');

function rejectReason(m, { deny, now }) {
  if (deny.includes(m.id)) return 'denied by pool.config.json';
  const out = (m.architecture && m.architecture.output_modalities) || ['text'];
  if (!out.includes('text')) return 'no text output';
  if (!(m.supported_parameters || []).includes('tools')) return 'no tool calling';
  const exp = expiryInfo(m.expiration_date, now);
  if (exp.expired) return `expired ${m.expiration_date}`;
  return null;
}

function selectOrStyle(data, { provider, isFree, deny = [], now = Date.now(), baseUrl, apiKeyEnv = null }) {
  const routes = [];
  const skipped = [];
  for (const m of data || []) {
    if (!isFree(m)) continue;
    const reason = rejectReason(m, { deny, now });
    if (reason) { skipped.push({ model: m.id, reason }); continue; }
    const exp = expiryInfo(m.expiration_date, now);
    const inputs = (m.architecture && m.architecture.input_modalities) || ['text'];
    const top = m.top_provider || {};
    routes.push({
      provider,
      model: m.id,
      key: `${provider}:${m.id}`,
      canonical: canonical(m.id),
      ctx: m.context_length || top.context_length || null,
      maxOut: top.max_completion_tokens || null,
      tools: true,
      vision: inputs.includes('image'),
      reasoning: (m.supported_parameters || []).includes('reasoning'),
      router: Boolean(m.autoRouting) || /^kilo-auto\//.test(m.id),
      expires: exp.expires,
      daysLeft: exp.daysLeft,
      logsPrompts: typeof m.mayTrainOnYourPrompts === 'boolean' ? m.mayTrainOnYourPrompts : null,
      baseUrl,
      apiKeyEnv,
    });
  }
  return { routes, skipped };
}

module.exports = { selectOrStyle };
