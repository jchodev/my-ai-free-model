'use strict';
// Loads .env (no dependencies) and pool.config.json. Never prints key values.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      const q = v[0];
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      const hash = v.search(/\s#/);
      if (hash >= 0) v = v.slice(0, hash).trim();
    }
    out[m[1]] = v;
  }
  return out;
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function loadEnvFile(file) {
  const text = readIfExists(file);
  return text === null ? {} : parseEnv(text);
}

function readJson(file, fallback) {
  const text = readIfExists(file);
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`);
  }
}

function getConfig({ root = ROOT, processEnv = process.env, fixtures = {}, dotenv = true } = {}) {
  const env = dotenv ? loadEnvFile(path.join(root, '.env')) : {};
  const pick = (k) => (processEnv[k] || env[k] || '').trim();
  const port = Number(pick('PORT') || 4570);
  return {
    root,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4570,
    keys: {
      openrouter: pick('OPENROUTER_API_KEY'),
      nvidia: pick('NVIDIA_API_KEY'),
      amd: pick('AMD_API_KEY'),
    },
    pool: readJson(path.join(root, 'pool.config.json'), {}),
    timeoutMs: 15000,
    fixtures, // { kilo: 'path.json', ... } for offline runs
  };
}

// Safe to print: booleans only.
function keyStatus(config) {
  return Object.fromEntries(Object.entries(config.keys).map(([k, v]) => [k, Boolean(v)]));
}

module.exports = { parseEnv, getConfig, keyStatus, ROOT };
