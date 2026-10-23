'use strict';
// Model groups: free-model-<group> only routes inside that group. Empty/unknown group -> whole pool.
// A route belongs to a group when its canonical name contains any of the group's "match" strings.

function groupNames(groupsCfg = {}) {
  return Object.keys(groupsCfg).filter((k) => !k.startsWith('_'));
}

function inGroup(route, spec) {
  const c = String(route.canonical || '').toLowerCase();
  return ((spec && spec.match) || []).some((p) => c.includes(String(p).toLowerCase()));
}

function buildGroups(routes, groupsCfg = {}) {
  const out = {};
  for (const name of groupNames(groupsCfg)) out[name] = routes.filter((r) => inGroup(r, groupsCfg[name]));
  return out;
}

// "free-model" -> all; "free-model-coder" -> group "coder"; anything else -> null (unknown model).
function resolveModelName(model, routes, groupsCfg = {}, prefix = 'free-model') {
  if (model === prefix) return { group: null, routes, fellBack: false };
  if (!model.startsWith(`${prefix}-`)) return null;
  const name = model.slice(prefix.length + 1);
  if (!groupNames(groupsCfg).includes(name)) return null;
  const members = buildGroups(routes, groupsCfg)[name];
  return members.length ? { group: name, routes: members, fellBack: false } : { group: name, routes, fellBack: true };
}

module.exports = { groupNames, inGroup, buildGroups, resolveModelName };
