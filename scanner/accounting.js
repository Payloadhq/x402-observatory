/**
 * Payload X402 Observatory — reproducible count accounting.
 *
 * Reads the raw discovery pull stats (data/discovered-*.json) and the merged
 * registry (data/registry.json) and prints the full ledger:
 *
 *   per-source: items seen -> junk removed -> usable listings ->
 *               expanded by accepts options -> dupes in pull -> unique keys
 *   cross-source: merged unique payment-option keys
 *
 * Also writes data/accounting.json for the dashboard builder.
 *
 * Usage: node scanner/accounting.js [--out ../data]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const outDir = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 ? process.argv[i + 1] : path.join(__dirname, '..', 'data');
})();

function latestPull(source) {
  const files = fs.readdirSync(outDir)
    .filter(f => f.startsWith('discovered-') && f.endsWith(`-${source}.json`))
    .sort();
  return files.length ? JSON.parse(fs.readFileSync(path.join(outDir, files[files.length - 1]), 'utf8')) : null;
}

function latestCombinedPull() {
  const files = fs.readdirSync(outDir)
    .filter(f => /^discovered-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return files.length ? JSON.parse(fs.readFileSync(path.join(outDir, files[files.length - 1]), 'utf8')) : null;
}

const sources = ['cdp', 'payai'];
const pulls = {};
const combined = latestCombinedPull();
for (const s of sources) pulls[s] = latestPull(s);
// Prefer per-source stats from the combined pull (same run); fall back to per-source files.

const reg = JSON.parse(fs.readFileSync(path.join(outDir, 'registry.json'), 'utf8'));
const resources = reg.resources || {};
const regKeys = Object.keys(resources);

// Cross-check registry composition by source tags
let fromCdp = 0, fromPayai = 0, fromBoth = 0;
for (const k of regKeys) {
  const srcs = resources[k].sources || [];
  if (srcs.includes('cdp') && srcs.includes('payai')) fromBoth++;
  else if (srcs.includes('cdp')) fromCdp++;
  else if (srcs.includes('payai')) fromPayai++;
}

const perSource = {};
let totalItemsSeen = 0, totalJunkRemoved = 0, totalUsableListings = 0, totalOptionKeys = 0, totalUniqueKeys = 0;
for (const s of sources) {
  const p = pulls[s] || {};
  // Combined pull (both sources, one run) carries the freshest per-source stats;
  // per-source pull files are the fallback for single-source runs.
  const ps = (combined && combined.perSource && combined.perSource[s]) || (p.perSource && p.perSource[s]) || {};
  const row = {
    name: ps.name || s,
    itemsSeen: ps.itemsSeen ?? null,
    junkRemoved: ps.junkRemoved ?? null,
    usableListings: ps.usableListings ?? p.rawRecordCount ?? null,
    uniqueKeys: p.uniqueKeys ?? null,
    newKeys: p.newKeys ?? null,
    updatedKeys: p.updatedKeys ?? null,
    dupInPull: p.dupInPull ?? null,
  };
  perSource[s] = row;
  if (row.itemsSeen != null) totalItemsSeen += row.itemsSeen;
  if (row.junkRemoved != null) totalJunkRemoved += row.junkRemoved;
  if (row.usableListings != null) totalUsableListings += row.usableListings;
  if (row.uniqueKeys != null) totalUniqueKeys += row.uniqueKeys;
}

const finalUnique = regKeys.length;
// Already-known keys re-seen in this pull (from any source, incl. the other catalog).
const combinedPull = combined || {};
const alreadyKnown = combinedPull.updatedKeys ?? (combinedPull.uniqueKeys != null ? combinedPull.uniqueKeys - combinedPull.newKeys : totalUniqueKeys - finalUnique);

const accounting = {
  generatedAt: new Date().toISOString(),
  definitions: {
    itemSeen: 'One raw catalog record returned by a discovery API (one resource listing).',
    junkRemoved: 'Records dropped before analysis: non-HTTP(S) URLs, localhost/loopback/example domains, malformed URLs, or listings with no usable payment option.',
    usableListing: 'A catalog listing with a valid resource URL and at least one payment option.',
    optionKey: 'One canonical payment option (resource URL + network + scheme) expanded from a listing\'s accepts array.',
    uniqueKey: 'One deduplicated payment-option key within a source pull.',
    finalUnique: 'One deduplicated payment-option key across all sources. This is what "RESOURCES DISCOVERED" means.',
  },
  perSource,
  totals: {
    itemsSeen: totalItemsSeen,
    junkRemoved: totalJunkRemoved,
    usableListings: totalUsableListings,
    optionKeysGenerated: combinedPull.optionKeysGenerated ?? totalOptionKeys ?? null,
    dupInPull: combinedPull.dupInPull ?? null,
    uniqueKeysInPull: combinedPull.uniqueKeys ?? null,
    alreadyKnownKeys: alreadyKnown,
    newKeysThisPull: combinedPull.newKeys ?? null,
    crossSourceKeys: fromBoth,   // registry keys listed by BOTH catalogs
    finalUnique,
  },
  registryCrossCheck: { fromCdpOnly: fromCdp, fromPayaiOnly: fromPayai, fromBoth: fromBoth, total: fromCdp + fromPayai + fromBoth },
  registryGeneratedAt: reg.generatedAt,
};

fs.writeFileSync(path.join(outDir, 'accounting.json'), JSON.stringify(accounting, null, 2));

const L = [];
L.push('X402 OBSERVATORY — COUNT ACCOUNTING');
L.push('====================================');
L.push('WHY UNIQUE > RAW: RAW counts catalog listings; each listing\'s accepts[] expands');
L.push('into multiple canonical payment options (URL + network + scheme).');
for (const s of sources) {
  const r = perSource[s];
  const na = (v) => v == null ? 'n/a' : v;
  const cov = s === 'cdp' ? fromCdp + fromBoth : fromPayai + fromBoth;
  L.push(`SOURCE ${s.toUpperCase()} (${r.name || s}):`);
  L.push(`  catalog items seen ............ ${na(r.itemsSeen)}`);
  L.push(`  junk removed .................. ${na(r.junkRemoved)}`);
  L.push(`  usable listings ............... ${na(r.usableListings)}`);
  L.push(`  registry keys tagged to src .. ${cov.toLocaleString()}  (cumulative coverage incl. cross-source)`);
}
L.push('TOTALS:');
L.push(`  items seen .................... ${totalItemsSeen}`);
L.push(`  junk removed .................. ${totalJunkRemoved}`);
L.push(`  LISTINGS DISCOVERED ........... ${totalUsableListings}  (unique usable catalog records)`);
L.push(`  expanded: option keys ......... ${combinedPull.optionKeysGenerated ?? 'n/a'}  (accepts[] -> URL+network+scheme)`);
L.push(`  dupes-in-pull removed ......... ${combinedPull.dupInPull ?? 'n/a'}`);
L.push(`  already in registry ........... ${alreadyKnown ?? 'n/a'}  (re-seen from prior pulls/sources)`);
L.push(`  new this pull ................. ${combinedPull.newKeys ?? 'n/a'}`);
L.push(`  keys listed by BOTH catalogs .. ${fromBoth}`);
L.push(`  RESOURCES DISCOVERED .......... ${finalUnique}  (unique URL + network + scheme payment options)`);
L.push(`registry cross-check: cdp-only ${fromCdp} / payai-only ${fromPayai} / both ${fromBoth} / total ${fromCdp + fromPayai + fromBoth}`);
console.log(L.join('\n'));
