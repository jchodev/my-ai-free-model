'use strict';
const { describeError } = require('../util');

const providers = [require('./kilo'), require('./openrouter'), require('./nvidia'), require('./amd')];
// Default order before any latency data exists: Kilo -> OpenRouter -> NVIDIA -> AMD.

async function discoverAll(config, { now = Date.now() } = {}) {
  const settled = await Promise.allSettled(providers.map((p) => p.discover(config, { now })));
  const routes = [];
  const report = [];
  settled.forEach((r, i) => {
    const name = providers[i].name;
    if (r.status === 'fulfilled') {
      const v = r.value;
      routes.push(...v.routes);
      report.push({
        provider: name, ok: !v.disabled, disabled: Boolean(v.disabled), routes: v.routes.length,
        skipped: v.skipped || [], notes: v.notes || [], candidates: v.candidates || [], error: null,
      });
    } else {
      report.push({ provider: name, ok: false, disabled: false, routes: 0, skipped: [], notes: [], candidates: [], error: describeError(r.reason) });
    }
  });
  return { routes, report };
}

module.exports = { providers, discoverAll };
