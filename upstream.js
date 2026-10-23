'use strict';
// One attempt against one route. Resolves { ok:true, res, ms, firstChunk? } or { ok:false, failure }.
const { classifyFailure, failureFromBody } = require('./failure');

function headersFor(route, keys) {
  const h = { 'content-type': 'application/json' };
  const k = keys[route.provider];
  if (k) h.authorization = `Bearer ${k}`;
  if (route.provider === 'openrouter') { h['x-title'] = 'my-ai-free-model'; }
  return h;
}

async function attempt(route, body, { keys, timeoutMs, fetchImpl = fetch, stream }) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const payload = JSON.stringify({ ...body, model: route.model, stream: !!stream });
  try {
    const res = await fetchImpl(`${route.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: headersFor(route, keys), body: payload, signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, failure: classifyFailure({ status: res.status, body: text }) };
    }
    if (!stream) {
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { return { ok: false, failure: classifyFailure({ status: 502, body: text }) }; }
      if (json.error || !json.choices) return { ok: false, failure: classifyFailure(failureFromBody(text)) };
      return { ok: true, json, ms: Date.now() - started };
    }
    // streaming: wait for the first chunk (inside the timeout) so we can still fail over.
    const reader = res.body.getReader();
    const first = await reader.read();
    if (first.done) return { ok: false, failure: classifyFailure({ status: 502, body: 'empty stream' }) };
    const head = Buffer.from(first.value).toString('utf8');
    if (/^\s*data:\s*\{\s*"error"/.test(head) || /^\s*\{\s*"error"/.test(head)) {
      return { ok: false, failure: classifyFailure(failureFromBody(head)) };
    }
    return { ok: true, reader, first: first.value, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, failure: classifyFailure(e.name === 'AbortError' ? { timedOut: true } : { code: e.cause?.code || e.message }) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { attempt };
