'use strict';
const http = require('node:http');
const { getConfig, keyStatus } = require('./config');
const { discoverAll } = require('./providers');
const { Router } = require('./router');
const { attempt } = require('./upstream');

const estimateTokens = (body) => Math.ceil(JSON.stringify(body.messages || []).length / 3.5);
const hasImages = (body) => JSON.stringify(body.messages || []).includes('"image_url"');
const hasVideoOrAudio = (body) => /"(input_audio|video_url|video)"/.test(JSON.stringify(body.messages || []));

function send(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}
const errBody = (message, type = 'proxy_error') => ({ error: { message, type } });

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleChat(req, res, ctx) {
  const { router, config, fetchImpl } = ctx;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, errBody('invalid JSON body', 'invalid_request_error')); }
  if (hasVideoOrAudio(body)) return send(res, 400, errBody('video and audio input are not supported', 'invalid_request_error'));
  const stream = body.stream === true;
  const plan = router.plan(body.model || 'free-model', {
    promptTokens: estimateTokens(body),
    reserve: Math.min(body.max_tokens || 1024, 8192),
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision: hasImages(body),
  });
  if (plan.error) return send(res, plan.error.status, errBody(plan.error.message, 'invalid_request_error'));

  const tried = [];
  for (const route of plan.routes) {
    const r = await attempt(route, body, { keys: config.keys, timeoutMs: config.firstByteMs || 20000, fetchImpl, stream });
    if (!r.ok) {
      router.recordFailure(route, r.failure);
      tried.push(`${route.key}: ${r.failure.kind} ${r.failure.status || ''} ${r.failure.msg}`.trim());
      continue;
    }
    router.recordSuccess(route, r.ms);
    if (!stream) {
      r.json.model = body.model || 'free-model';
      res.setHeader('x-free-model-route', route.key);
      return send(res, 200, r.json);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-free-model-route': route.key });
    res.write(r.first);
    try {
      for (;;) { const { done, value } = await r.reader.read(); if (done) break; res.write(value); }
    } catch (e) {
      res.write(`data: ${JSON.stringify(errBody(`upstream stream broke: ${e.message}`))}\n\n`);
    }
    return res.end();
  }
  return send(res, 503, errBody(`all routes failed: ${tried.join(' | ')}`));
}

function createServer({ config, router, fetchImpl = fetch }) {
  const ctx = { config, router, fetchImpl };
  return http.createServer(async (req, res) => {
    try {
      const url = req.url.split('?')[0];
      if (req.method === 'GET' && url === '/v1/models') {
        return send(res, 200, { object: 'list', data: router.modelNames().map((id) => ({ id, object: 'model', owned_by: 'my-ai-free-model' })) });
      }
      if (req.method === 'GET' && (url === '/status' || url === '/')) return send(res, 200, router.status());
      if (req.method === 'POST' && url === '/v1/chat/completions') return await handleChat(req, res, ctx);
      return send(res, 404, errBody(`no route for ${req.method} ${url}`, 'invalid_request_error'));
    } catch (e) {
      if (!res.headersSent) send(res, 500, errBody(e.message)); else res.end();
    }
  });
}

async function main() {
  const config = getConfig();
  const { routes, report } = await discoverAll(config);
  const router = new Router({ routes, groups: config.pool.groups || {} });
  const server = createServer({ config, router });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`my-ai-free-model on http://127.0.0.1:${config.port}  (${routes.length} routes)`);
    console.log('keys:', JSON.stringify(keyStatus(config)));
    console.log('models:', router.modelNames().join(', '));
  });
  return report;
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { createServer };
