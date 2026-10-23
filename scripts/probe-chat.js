#!/usr/bin/env node
'use strict';
// Sends one tiny chat and one tool-calling request to routes of ONE provider (uses a little free quota).
//   node scripts/probe-chat.js nvidia                    all allow-listed NVIDIA routes
//   node scripts/probe-chat.js nvidia --id moonshotai/kimi-k2.6   test an id that is not in the allow-list yet
//   node scripts/probe-chat.js amd --model Qwen           only routes whose id contains "Qwen"
//   node scripts/probe-chat.js nvidia --scan --yes   try EVERY model in the provider list (chat first; ~1.5s each)
//   --timeout <seconds> per request (default 60; 20 with --scan)
//   add --yes to probe more than 8 routes (e.g. openrouter has a small daily cap)
const { getConfig } = require('../config');
const { discoverAll, providers } = require('../providers');
const { fetchJson, describeError } = require('../util');

const TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

function errText(e) {
  let msg = '';
  try { const j = JSON.parse(e.body || '{}'); msg = (j.error && (j.error.message || j.error)) || (j.detail && j.detail.error && j.detail.error.message) || ''; } catch { /* ignore */ }
  return `${describeError(e)}${msg ? ' ' + String(msg).slice(0, 110) : ''}`;
}

// post(url, headers, body) -> parsed JSON. Injectable for tests.
async function probeRoute(route, apiKey, post) {
  const url = `${route.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const out = { route: `${route.provider}:${route.model}`, chat: null, ms: null, tools: null, note: '' };

  let t = Date.now();
  try {
    const j = await post(url, headers, { model: route.model, max_tokens: 256, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] });
    out.ms = Date.now() - t;
    const c = j.choices && j.choices[0];
    if (!c) { out.chat = 'no-choices'; return out; }
    const hasText = Boolean(c.message && c.message.content);
    out.chat = hasText ? 'ok' : c.finish_reason === 'length' ? 'ok(thinking-only)' : 'ok(empty)';
  } catch (e) {
    out.ms = Date.now() - t;
    out.chat = `FAIL ${errText(e)}`;
    return out; // no point testing tools
  }

  try {
    const j = await post(url, headers, {
      model: route.model, max_tokens: 400, tools: [TOOL], tool_choice: 'auto',
      messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the tool.' }],
    });
    const m = j.choices && j.choices[0] && j.choices[0].message;
    out.tools = m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 ? 'yes' : 'no-call';
  } catch (e) {
    out.tools = `FAIL ${errText(e)}`;
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];
  const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const provider = providers.find((p) => p.name === name);
  if (!provider) { console.error(`usage: node scripts/probe-chat.js <${providers.map((p) => p.name).join('|')}> [--id X] [--model substr] [--yes]`); process.exit(2); }

  const config = getConfig();
  const apiKey = config.keys[name] || '';
  if (name !== 'kilo' && !apiKey) { console.error(`${name}: API key not set in .env`); process.exit(2); }

  const scan = argv.includes('--scan');
  let routes;
  if (scan) {
    const rep = (await discoverAll(config)).report.find((r) => r.provider === name);
    const ids = rep && rep.candidates && rep.candidates.length ? rep.candidates : null;
    if (!ids) { console.error(`--scan: ${name} reports no extra candidates (only NVIDIA does)`); process.exit(2); }
    routes = ids.map((id) => ({ provider: name, model: id, baseUrl: provider.BASE }));
  } else if (val('--id')) {
    routes = [{ provider: name, model: val('--id'), baseUrl: provider.BASE }];
  } else {
    routes = (await discoverAll(config)).routes.filter((r) => r.provider === name);
    if (val('--model')) routes = routes.filter((r) => r.model.includes(val('--model')));
  }
  if (!routes.length) { console.error('no routes to probe'); process.exit(1); }
  if (routes.length > 8 && !argv.includes('--yes')) {
    console.error(`${routes.length} routes would use ${routes.length * 2} free requests. Re-run with --yes, or narrow with --model.`);
    process.exit(2);
  }

  const timeoutMs = (Number(val('--timeout')) || (scan ? 20 : 60)) * 1000;
  const post = (url, headers, body) => fetchJson(url, { method: 'POST', headers, body, timeoutMs });
  const good = [];
  for (const r of routes) {
    const o = await probeRoute(r, apiKey, post);
    if (String(o.chat).startsWith('ok') && o.tools === 'yes') good.push(r.model);
    console.log(`${o.route.padEnd(58)} chat=${o.chat}  ${o.ms}ms  tools=${o.tools === null ? '-' : o.tools}`);
    await new Promise((res) => setTimeout(res, 1500)); // be polite: stay under RPM limits
  }
  if (scan) {
    console.log(`\nCallable with tool calling (${good.length}/${routes.length}). Paste into pool.config.json \"${name}.allow\":`);
    console.log(JSON.stringify(good, null, 2));
  }
}

if (require.main === module) main().catch((e) => { console.error('probe-chat failed:', e.message); process.exit(1); });
module.exports = { probeRoute };
