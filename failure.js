'use strict';
// Turns an upstream failure into { kind, status, msg } so the router can decide the cooldown.
// kinds: auth | notfound | rate | daily | server | timeout | network | client

function messageOf(body) {
  const text = String(body || '');
  try {
    const j = JSON.parse(text.replace(/^\s*data:\s*/, ''));
    const e = j.error || (j.detail && j.detail.error) || j;
    return String(e.message || e.code || (typeof e === 'string' ? e : '') || '').slice(0, 200) || text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

function classifyFailure({ status, body, timedOut, code } = {}) {
  if (timedOut) return { kind: 'timeout', status: 0, msg: 'timeout' };
  if (!status) return { kind: 'network', status: 0, msg: String(code || 'network error') };
  const msg = messageOf(body);
  if (status === 401 || status === 403) return { kind: 'auth', status, msg };
  if (status === 404) return { kind: 'notfound', status, msg };
  if (status === 429 || status === 402) {
    return { kind: /per[- ]day|daily|quota/i.test(String(body)) ? 'daily' : 'rate', status, msg };
  }
  if (status === 408 || status >= 500) return { kind: 'server', status, msg };
  return { kind: 'client', status, msg };
}

// Some gateways answer 200 and put an error object in the body / first SSE frame.
function failureFromBody(text) {
  let status = 502;
  try {
    const j = JSON.parse(String(text).replace(/^\s*data:\s*/, ''));
    const e = j.error || {};
    const c = Number(e.code || e.status);
    if (c >= 400 && c < 600) status = c;
    else if (/rate.?limit/i.test(JSON.stringify(e))) status = 429;
  } catch { /* keep 502 */ }
  return { status, body: String(text).slice(0, 500) };
}

module.exports = { classifyFailure, failureFromBody, messageOf };
