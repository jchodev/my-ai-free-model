'use strict';
const fs = require('fs');

const UA = 'my-ai-free-model/0.1 (local proxy)';

// GET/POST JSON. Throws Error with .status for HTTP errors. Never includes request headers in errors.
async function fetchJson(url, { headers = {}, timeoutMs = 15000, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  try { return JSON.parse(text); } catch {
    const err = new Error(`non-JSON response from ${new URL(url).host}`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
}

// Reads a saved response (may start with a pasted "curl ..." line): takes first '{' .. last '}'.
function readFixture(file) {
  const s = fs.readFileSync(file, 'utf8');
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}

async function getModels(url, { headers, timeoutMs, fixture }) {
  return fixture ? readFixture(fixture) : fetchJson(url, { headers, timeoutMs });
}

// Same model on different gateways -> same canonical name.
function canonical(id) {
  let s = String(id).toLowerCase();
  s = s.replace(/^self-dploy\//, '').replace(/:free$/, '');
  s = s.split('/').pop();
  return s.replace(/-free$/, '');
}

// "2026-10-31" means valid through the end of that day (UTC).
function expiryInfo(dateStr, now = Date.now()) {
  if (!dateStr) return { expires: null, expired: false, daysLeft: null };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `${dateStr}T23:59:59Z` : dateStr;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { expires: String(dateStr), expired: false, daysLeft: null };
  return { expires: String(dateStr), expired: t < now, daysLeft: Math.ceil((t - now) / 86400000) };
}

function describeError(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timeout';
  if (e && e.status) return `HTTP ${e.status}`;
  return (e && e.cause && e.cause.code) || (e && e.message) || 'unknown error';
}

module.exports = { fetchJson, readFixture, getModels, canonical, expiryInfo, describeError, UA };
