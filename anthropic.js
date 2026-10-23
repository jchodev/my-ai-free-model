'use strict';
// Anthropic /v1/messages  <->  OpenAI /v1/chat/completions translation (for Claude Code).
const crypto = require('node:crypto');

const rid = (p) => `${p}_${crypto.randomBytes(12).toString('hex')}`;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : '');

// Claude Code may send real Claude names (e.g. for title generation); map them to our groups.
function mapModel(name = '') {
  const n = String(name).toLowerCase();
  if (n.startsWith('free-model')) return name;
  if (n.includes('opus')) return 'free-model-thinking';
  if (n.includes('sonnet')) return 'free-model-coder';
  if (n.includes('haiku')) return 'free-model-fast';
  return 'free-model';
}

function toOpenAI(body) {
  const messages = [];
  const sys = Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n\n') : body.system;
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
      continue;
    }
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? '[error] ' : '') + textOf(b.content) });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source) {
        const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }
  const out = { model: mapModel(body.model), messages };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences && body.stop_sequences.length) out.stop = body.stop_sequences;
  const tools = (body.tools || []).filter((t) => t.input_schema);
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema } }));
    const tc = body.tool_choice;
    if (tc) {
      if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
      else if (tc.type === 'none') out.tool_choice = 'none';
      else out.tool_choice = 'auto';
    }
  }
  return out;
}

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
const stopReason = (fr, usedTools) => (usedTools ? 'tool_use' : STOP[fr] || 'end_turn');
const estimateTokens = (o) => Math.ceil(JSON.stringify({ m: o.messages, t: o.tools }).length / 3.5);
const safeJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

function toAnthropic(json, { model, thinking }) {
  const msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
  const content = [];
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (thinking && reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    content.push({ type: 'tool_use', id: c.id || rid('toolu'), name: c.function.name, input: safeJson(c.function.arguments) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const u = json.usage || {};
  return {
    id: rid('msg'), type: 'message', role: 'assistant', model, content,
    stop_reason: stopReason(json.choices[0].finish_reason, (msg.tool_calls || []).length > 0),
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
  };
}

// Parses an SSE byte stream into JSON objects (ignores [DONE] and junk).
class SseParser {
  constructor() { this.buf = ''; this.dec = new TextDecoder(); }
  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.dec.decode(chunk, { stream: true });
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { out.push(JSON.parse(data)); } catch { /* skip */ }
    }
    return out;
  }
}

class StreamTranslator {
  constructor({ model, inputTokens = 0, thinking = false, write }) {
    this.model = model; this.inputTokens = inputTokens; this.thinking = thinking; this.write = write;
    this.idx = -1; this.cur = null; this.usedTools = false; this.finish = null; this.outChars = 0; this.usage = null;
  }
  emit(type, data) { this.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }
  start() {
    this.emit('message_start', { message: { id: rid('msg'), type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: this.inputTokens, output_tokens: 1 } } });
  }
  close() { if (this.cur) { this.emit('content_block_stop', { index: this.idx }); this.cur = null; } }
  open(kind, key, block) {
    if (this.cur && this.cur.kind === kind && this.cur.key === key) return;
    this.close();
    this.idx++;
    this.cur = { kind, key };
    this.emit('content_block_start', { index: this.idx, content_block: block });
  }
  delta(d) { this.emit('content_block_delta', { index: this.idx, delta: d }); }
  feed(json) {
    if (json.usage) this.usage = json.usage;
    const ch = json.choices && json.choices[0];
    if (!ch) return;
    const d = ch.delta || {};
    const reasoning = d.reasoning_content || d.reasoning;
    if (reasoning && this.thinking) {
      this.open('thinking', 0, { type: 'thinking', thinking: '' });
      this.delta({ type: 'thinking_delta', thinking: reasoning });
    }
    if (d.content) {
      this.outChars += d.content.length;
      this.open('text', 0, { type: 'text', text: '' });
      this.delta({ type: 'text_delta', text: d.content });
    }
    for (const tc of d.tool_calls || []) {
      const key = tc.index ?? 0;
      this.usedTools = true;
      this.open('tool_use', key, { type: 'tool_use', id: tc.id || rid('toolu'), name: (tc.function && tc.function.name) || '', input: {} });
      const args = tc.function && tc.function.arguments;
      if (args) { this.outChars += args.length; this.delta({ type: 'input_json_delta', partial_json: args }); }
    }
    if (ch.finish_reason) this.finish = ch.finish_reason;
  }
  end() {
    if (this.idx < 0) { this.open('text', 0, { type: 'text', text: '' }); }
    this.close();
    const out = (this.usage && this.usage.completion_tokens) || Math.ceil(this.outChars / 3.5);
    this.emit('message_delta', { delta: { stop_reason: stopReason(this.finish, this.usedTools), stop_sequence: null }, usage: { output_tokens: out } });
    this.emit('message_stop', {});
  }
}

module.exports = { mapModel, toOpenAI, toAnthropic, estimateTokens, SseParser, StreamTranslator };
