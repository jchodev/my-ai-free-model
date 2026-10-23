'use strict';
// Picks routes for a request, learns latency from real traffic, cools failing routes down.
const { resolveModelName, groupNames } = require('./groups');

const MIN = 60 * 1000;
const POLICY = {
  rate: { base: 10 * MIN, max: 120 * MIN },
  daily: { base: 60 * MIN, max: 360 * MIN },
  server: { base: 2 * MIN, max: 20 * MIN },
  timeout: { base: 2 * MIN, max: 20 * MIN },
  network: { base: 2 * MIN, max: 20 * MIN },
  client: { base: 5 * MIN, max: 5 * MIN },
};
const PROVIDER_ORDER = ['kilo', 'openrouter', 'nvidia', 'amd'];

class Router {
  constructor({ routes = [], groups = {}, sharedBackends = [['kilo', 'openrouter']], now = Date.now, priorMs = 3000 } = {}) {
    this.groups = groups;
    this.sharedBackends = sharedBackends;
    this.now = now;
    this.priorMs = priorMs;
    this.state = new Map();
    this.providerDisabled = new Map();
    this.routes = [];
    this.setRoutes(routes);
  }

  setRoutes(routes) {
    this.routes = routes;
    for (const r of routes) this._st(r);
  }

  _st(route) {
    if (!this.state.has(route.key)) {
      this.state.set(route.key, { cooldownUntil: 0, strikes: 0, ewma: null, disabled: null, ok: 0, fail: 0, lastError: null });
    }
    return this.state.get(route.key);
  }

  _available(route) {
    return !this.providerDisabled.has(route.provider) && !this._st(route).disabled;
  }

  _fits(route, { promptTokens, reserve, tools, vision }) {
    if (route.ctx && route.ctx < promptTokens + reserve) return false;
    if (tools && route.tools === false) return false;
    if (vision && route.vision !== true) return false;
    return true;
  }

  _siblings(route) {
    const sets = this.sharedBackends.filter((s) => s.includes(route.provider));
    return this.routes.filter((r) => r.key !== route.key && r.canonical === route.canonical && sets.some((s) => s.includes(r.provider)));
  }

  modelNames() {
    return ['free-model', ...groupNames(this.groups).map((n) => `free-model-${n}`)];
  }

  // -> { routes, group, fellBack, widened } or { error: { status, message } }
  plan(modelName, { promptTokens = 0, reserve = 1024, tools = false, vision = false } = {}) {
    const resolved = resolveModelName(modelName, this.routes, this.groups);
    if (!resolved) {
      return { error: { status: 404, message: `model "${modelName}" not found. Available: ${this.modelNames().join(', ')}` } };
    }
    const need = { promptTokens, reserve, tools, vision };
    const pick = (list) => list.filter((r) => this._available(r) && this._fits(r, need));
    let pool = pick(resolved.routes);
    let widened = false;
    if (!pool.length && resolved.group && !resolved.fellBack) { pool = pick(this.routes); widened = true; }
    if (!pool.length) {
      return { error: { status: 503, message: `no available route fits this request (tools=${tools}, images=${vision}, ~${promptTokens + reserve} tokens needed)` } };
    }
    const t = this.now();
    const score = (r) => { const e = this._st(r).ewma; return e === null ? this.priorMs + (this._siblings(r).length ? 1 : 0) : e; };
    const rank = (r) => { const i = PROVIDER_ORDER.indexOf(r.provider); return i < 0 ? 99 : i; };
    const byFast = (a, b) => score(a) - score(b) || rank(a) - rank(b) || a.key.localeCompare(b.key);
    const healthy = pool.filter((r) => this._st(r).cooldownUntil <= t).sort(byFast);
    const cooling = pool.filter((r) => this._st(r).cooldownUntil > t).sort((a, b) => this._st(a).cooldownUntil - this._st(b).cooldownUntil);
    // If everything is cooling down, still try the two that recover first instead of stalling.
    const ordered = healthy.length ? [...healthy, ...cooling] : cooling.slice(0, 2);
    return { routes: ordered, group: resolved.group, fellBack: resolved.fellBack, widened };
  }

  recordSuccess(route, ms) {
    const st = this._st(route);
    st.ok++;
    st.strikes = 0;
    st.cooldownUntil = 0;
    st.lastError = null;
    if (Number.isFinite(ms) && ms >= 0) st.ewma = st.ewma === null ? ms : st.ewma * 0.7 + ms * 0.3;
  }

  recordFailure(route, failure) {
    const st = this._st(route);
    st.fail++;
    st.lastError = `${failure.kind}: ${failure.msg}`.slice(0, 200);
    if (failure.kind === 'auth') { this.providerDisabled.set(route.provider, `auth failed (HTTP ${failure.status}) - check the key in .env`); return; }
    if (failure.kind === 'notfound') { st.disabled = 'model not found (404)'; return; }
    const pol = POLICY[failure.kind] || POLICY.server;
    if (failure.kind !== 'client') st.strikes++;
    const ms = Math.min(pol.base * 2 ** Math.max(0, st.strikes - 1), pol.max);
    const until = this.now() + ms;
    st.cooldownUntil = Math.max(st.cooldownUntil, until);
    if (failure.kind === 'rate' || failure.kind === 'daily') {
      for (const s of this._siblings(route)) {
        const ss = this._st(s);
        ss.cooldownUntil = Math.max(ss.cooldownUntil, until);
      }
    }
  }

  status() {
    const t = this.now();
    return {
      providersDisabled: Object.fromEntries(this.providerDisabled),
      routes: this.routes.map((r) => {
        const st = this._st(r);
        let state = 'ok';
        if (this.providerDisabled.has(r.provider)) state = 'provider-disabled';
        else if (st.disabled) state = `disabled: ${st.disabled}`;
        else if (st.cooldownUntil > t) state = `cooling ${Math.ceil((st.cooldownUntil - t) / 1000)}s`;
        return { route: r.key, state, latencyMs: st.ewma === null ? null : Math.round(st.ewma), ok: st.ok, fail: st.fail, lastError: st.lastError };
      }),
    };
  }
}

module.exports = { Router, POLICY, PROVIDER_ORDER };
