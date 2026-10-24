'use strict';
// OpenAPI 3.0 description of this server, plus a Swagger UI page (assets loaded from a CDN, no npm dependency).

const SWAGGER_UI_VERSION = '5.17.14';

function buildSpec(modelNames = ['free-model']) {
  const model = { type: 'string', enum: modelNames, default: modelNames[0], description: 'free-model = whole pool; free-model-<group> = one group' };
  const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  return {
    openapi: '3.0.3',
    info: {
      title: 'my-ai-free-model',
      version: '0.1.0',
      description: 'Local proxy that exposes one model name (`free-model`) and routes across free LLM providers with automatic failover and cooldown. Listens on 127.0.0.1 only. No API key is checked.\n\nNo video or audio input. Images only reach routes that support vision.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'OpenAI format', description: 'OpenCode, Cline, Cursor and other OpenAI-compatible clients' },
      { name: 'Anthropic format', description: 'Claude Code' },
      { name: 'Ops' },
    ],
    paths: {
      '/v1/models': {
        get: { tags: ['OpenAI format'], summary: 'List model names (free-model and its groups)', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ModelList' } } } } } },
      },
      '/v1/chat/completions': {
        post: {
          tags: ['OpenAI format'], summary: 'Chat completion (streaming and tool calling supported)',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' }, example: { model: 'free-model-fast', messages: [{ role: 'user', content: 'say hi in 3 words' }] } } } },
          responses: {
            200: { description: 'OpenAI chat completion, or an SSE stream when `stream` is true. Header `x-free-model-route` tells which route answered.', content: { 'application/json': { schema: { type: 'object' } }, 'text/event-stream': { schema: { type: 'string' } } } },
            400: err, 404: err, 503: err,
          },
        },
      },
      '/v1/messages': {
        post: {
          tags: ['Anthropic format'], summary: 'Anthropic Messages API (translated to the same router)',
          description: 'Claude model names are mapped: opus → free-model-thinking, sonnet → free-model-coder, haiku → free-model-fast.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MessagesRequest' }, example: { model: 'free-model-coder', max_tokens: 200, messages: [{ role: 'user', content: 'say hi in 3 words' }] } } } },
          responses: {
            200: { description: 'Anthropic message, or Anthropic SSE events when `stream` is true.', content: { 'application/json': { schema: { type: 'object' } }, 'text/event-stream': { schema: { type: 'string' } } } },
            400: err, 404: err, 503: err,
          },
        },
      },
      '/v1/messages/count_tokens': {
        post: {
          tags: ['Anthropic format'], summary: 'Estimate input tokens (rough estimate, not exact)',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MessagesRequest' } } } },
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { input_tokens: { type: 'integer' } } } } } } },
        },
      },
      '/status': {
        get: { tags: ['Ops'], summary: 'Per-route latency, cooldown and last error', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Status' } } } } } },
      },
      '/openapi.json': { get: { tags: ['Ops'], summary: 'This OpenAPI document', responses: { 200: { description: 'OK' } } } },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' } } } } },
        ModelList: { type: 'object', properties: { object: { type: 'string', example: 'list' }, data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, object: { type: 'string' }, owned_by: { type: 'string' } } } } } },
        ChatRequest: {
          type: 'object', required: ['messages'],
          properties: {
            model, stream: { type: 'boolean', default: false },
            messages: { type: 'array', items: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] }, content: { description: 'string, or an array of text / image_url parts' } } } },
            tools: { type: 'array', items: { type: 'object' } }, tool_choice: {}, max_tokens: { type: 'integer' }, temperature: { type: 'number' },
          },
        },
        MessagesRequest: {
          type: 'object', required: ['messages'],
          properties: {
            model, max_tokens: { type: 'integer', default: 1024 }, stream: { type: 'boolean', default: false }, system: { description: 'string or text blocks' },
            messages: { type: 'array', items: { type: 'object', required: ['role', 'content'], properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { description: 'string, or blocks: text, image, tool_use, tool_result' } } } },
            tools: { type: 'array', items: { type: 'object' } }, tool_choice: { type: 'object' }, thinking: { type: 'object', description: '{ "type": "enabled" } returns the model\'s reasoning as a thinking block' },
          },
        },
        Status: {
          type: 'object',
          properties: {
            providersDisabled: { type: 'object', additionalProperties: { type: 'string' } },
            routes: { type: 'array', items: { type: 'object', properties: { route: { type: 'string' }, state: { type: 'string', example: 'ok' }, latencyMs: { type: 'integer', nullable: true }, ok: { type: 'integer' }, fail: { type: 'integer' }, lastError: { type: 'string', nullable: true } } } },
          },
        },
      },
    },
  };
}

function docsHtml() {
  const v = SWAGGER_UI_VERSION;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>my-ai-free-model API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${v}/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${v}/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui' });</script>
</body></html>`;
}

module.exports = { buildSpec, docsHtml };
