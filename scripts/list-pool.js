#!/usr/bin/env node
'use strict';
// Shows which free models would join the routing pool.
//   node scripts/list-pool.js                 live (needs network + keys in .env)
//   node scripts/list-pool.js --json          machine-readable
//   node scripts/list-pool.js --fixture kilo=path/to/saved-response.txt   offline test
const { getConfig, keyStatus } = require('../config');
const { discoverAll } = require('../providers');
const { buildGroups, groupNames } = require('../groups');

function parseArgs(argv) {
  const args = { json: false, all: false, fixtures: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--fixture') {
      const [name, file] = String(argv[++i] || '').split('=');
      if (!name || !file) throw new Error('--fixture needs name=path');
      args.fixtures[name] = file;
    }
  }
  return args;
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig({ fixtures: args.fixtures });
  const { routes, report } = await discoverAll(config);

  if (args.json) { console.log(JSON.stringify({ routes, report }, null, 2)); return; }

  console.log('Keys set:', Object.entries(keyStatus(config)).map(([k, v]) => `${k}=${v ? 'yes' : 'NO'}`).join('  '));
  console.log('');
  for (const r of report) {
    const status = r.error ? `ERROR ${r.error}` : r.disabled ? 'skipped' : `${r.routes} routes`;
    console.log(`== ${r.provider}: ${status}`);
    r.notes.forEach((n) => console.log(`   note: ${n}`));
    const own = routes.filter((x) => x.provider === r.provider);
    for (const x of own) {
      const flags = [
        x.vision ? 'vision' : '', x.reasoning ? 'reasoning' : '', x.router ? 'auto-router' : '',
        x.daysLeft !== null && x.daysLeft <= 14 ? `EXPIRES ${x.expires} (${x.daysLeft}d)` : '',
        x.logsPrompts ? 'logs-prompts' : '',
      ].filter(Boolean).join(' ');
      console.log(`   ${pad(x.model, 52)} ctx=${pad(x.ctx === null ? '?' : x.ctx, 8)} ${flags}`);
    }
    if (r.skipped.length) {
      console.log(`   skipped ${r.skipped.length}: ` + r.skipped.map((s) => `${s.model} (${s.reason})`).join('; '));
    }
    if (r.candidates.length) {
      console.log(`   chat-like models NOT in allow-list (${r.candidates.length}); add good ones to pool.config.json:`);
      const shown = args.all ? r.candidates : r.candidates.slice(0, 40);
      console.log('   ' + shown.join(', ') + (shown.length < r.candidates.length ? ', ... (use --all to see every id)' : ''));
    }
    console.log('');
  }

  const groups = new Map();
  for (const x of routes) { if (!groups.has(x.canonical)) groups.set(x.canonical, []); groups.get(x.canonical).push(x.provider); }
  const dup = [...groups].filter(([, p]) => p.length > 1);
  console.log(`Total routes: ${routes.length}`);
  const g = buildGroups(routes, config.pool.groups);
  for (const name of groupNames(config.pool.groups)) {
    console.log(`\nGroup free-model-${name}: ${g[name].length} routes${g[name].length ? '' : ' (empty -> falls back to whole pool)'}`);
    console.log('   ' + g[name].map((r) => `${r.provider}:${r.canonical}`).join(', '));
  }
  console.log('');
  if (dup.length) {
    console.log('Same model on several gateways (may share one backend):');
    dup.forEach(([c, p]) => console.log(`   ${pad(c, 34)} ${p.join(' + ')}`));
  }
}

main().catch((e) => { console.error('list-pool failed:', e.message); process.exit(1); });
