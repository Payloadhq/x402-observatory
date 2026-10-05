/**
 * Payload X402 Observatory — Bazaar discovery ingestion.
 *
 * Pulls public x402 resource catalogs (no auth, no payments):
 *  - CDP Bazaar:  GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=N&offset=M
 *  - PayAI Bazaar: GET https://facilitator.payai.network/discovery/resources?limit=N&offset=M
 *
 * Politeness: max 1 request per 2 seconds per host, 30s timeout, modest UA.
 * Collects ONLY publicly exposed metadata. payTo is truncated to 10 chars + "...".
 * Merges into data/registry.json (durable registry) and writes data/discovered-YYYY-MM-DD.json (raw pull).
 *
 * Usage: node scanner/ingest-bazaar.js [--out ../data] [--max-pages N]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const UA = 'Payload-X402-Observatory (+https://payloadhq.github.io/)';
const PAGE_MIN_MS = 2000;      // max 1 req / 2s per host
const TIMEOUT_MS = 30000;
const PAGE_LIMIT = 200;

const SOURCES = [
  {
    id: 'cdp',
    name: 'CDP x402 Bazaar',
    base: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources',
  },
  {
    id: 'payai',
    name: 'PayAI Bazaar',
    base: 'https://facilitator.payai.network/discovery/resources',
  },
];

// Network normalization -> CAIP-style canonical id where possible
const NETWORK_ALIASES = {
  'base': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'ethereum': 'eip155:1',
  'sepolia': 'eip155:11155111',
  'arbitrum': 'eip155:42161',
  'arbitrum-sepolia': 'eip155:421614',
  'polygon': 'eip155:137',
  'avalanche': 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
};

// Known asset decimals (atomic units -> whole tokens). Unknown -> null.
const ASSET_DECIMALS = {
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 6, // USDC Base
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkZwyTDt1v': 6, // USDC Solana
  '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': 6, // USDC Ethereum (v2 token messenger)
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': 6, // USDC Polygon
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 6, // USDC Arbitrum
  'BUSDio82W3oJcXyLz9j0x1iK2mN3oP4qR5sT6u': null,
};

const JUNK_PATTERNS = [
  /localhost/i, /127\.\d+\.\d+\.\d+/, /::1/, /\.local$/i, /\.internal$/i,
  /0\.0\.0\.0/, /example\.com$/i, /example\.org$/i, /example\.net$/i,
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const lastHit = new Map();

function politeJson(url, minMs) {
  const delay = minMs || PAGE_MIN_MS;
  return (async () => {
    const u = new URL(url);
    const since = Date.now() - (lastHit.get(u.host) || 0);
    if (since < delay) await sleep(delay - since);
    lastHit.set(u.host, Date.now());
    return new Promise((resolve) => {
      const req = https.request(u, {
        method: 'GET',
        headers: { 'user-agent': UA, 'accept': 'application/json' },
        timeout: TIMEOUT_MS,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { if (buf.length < 50 * 1024 * 1024) buf += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
          try { resolve({ ok: true, data: JSON.parse(buf) }); }
          catch (e) { resolve({ ok: false, error: 'bad json' }); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.on('error', (e) => resolve({ ok: false, error: e.message || 'request error' }));
      req.end();
    });
  })();
}

function truncAddr(a) {
  if (!a || typeof a !== 'string') return null;
  return a.length > 13 ? a.slice(0, 10) + '...' : a;
}

function normalizeNetwork(n) {
  if (!n || typeof n !== 'string') return null;
  const low = n.toLowerCase();
  return NETWORK_ALIASES[low] || n;
}

function isJunkUrl(raw) {
  if (!raw || typeof raw !== 'string') return true;
  let u;
  try { u = new URL(raw); } catch { return true; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return true;
  if (!u.hostname || u.hostname.length < 4) return true;
  return JUNK_PATTERNS.some((re) => re.test(u.hostname));
}

function normalizeUrl(raw) {
  const u = new URL(raw);
  let host = u.hostname.toLowerCase();
  // strip default ports
  const port = u.port;
  if ((u.protocol === 'https:' && port === '443') || (u.protocol === 'http:' && port === '80')) { /* default */ }
  let p = u.pathname || '/';
  p = p.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${host}${port && !((u.protocol === 'https:' && port === '443') || (u.protocol === 'http:' && port === '80')) ? ':' + port : ''}${p}`;
}

function serviceName(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return null; }
}

function priceBucket(amountAtomic, decimals) {
  if (amountAtomic == null || decimals == null) return 'unknown';
  const v = Number(amountAtomic) / Math.pow(10, decimals);
  if (!isFinite(v) || v < 0) return 'unknown';
  if (v < 0.01) return 'under-$0.01';
  if (v < 0.10) return '$0.01-$0.10';
  if (v < 1) return '$0.10-$1';
  if (v < 10) return '$1-$10';
  return 'over-$10';
}

/** Extract our normalized record from a raw catalog item. Returns null if junk. */
function extractItem(sourceId, item) {
  const resource = item.resource || (item.accepts && item.accepts[0] && item.accepts[0].resource);
  if (isJunkUrl(resource)) return null;
  const url = normalizeUrl(resource);
  const accepts = Array.isArray(item.accepts) ? item.accepts : [];
  const options = accepts.map((a) => {
    const network = normalizeNetwork(a.network);
    const scheme = (a.scheme || 'unknown').toLowerCase();
    const asset = typeof a.asset === 'string' ? a.asset : (typeof a.currency === 'string' ? a.currency : null);
    const amountAtomic = a.amount || a.maxAmountRequired || null;
    const decimals = asset && ASSET_DECIMALS[asset] !== undefined ? ASSET_DECIMALS[asset] : null;
    return {
      scheme,
      network,
      asset: asset && asset.length > 64 ? null : asset,
      amountAtomic: amountAtomic != null ? String(amountAtomic) : null,
      priceBucket: priceBucket(amountAtomic, decimals),
      payToTrunc: truncAddr(a.payTo || a.recipient),
      mimeType: a.mimeType || null,
    };
  }).filter(o => o.network && o.scheme);
  if (options.length === 0) return null;

  const x402Version = item.x402Version || (item.x402version) || null;
  const desc = typeof item.description === 'string' ? item.description.slice(0, 240) : null;
  const tags = Array.isArray(item.tags) ? item.tags.slice(0, 10).map(String) : [];
  const ext = item.extensions || item.metadata || {};
  const extensionsPresent = !!(ext && ext.bazaar) || Object.keys(ext).length > 0;

  return {
    url,
    host: serviceName(url),
    serviceName: serviceName(url),
    type: item.type || 'http',
    x402Version: x402Version ? Number(x402Version) : null,
    options,
    description: desc,
    tags,
    extensionsPresent,
    lastUpdated: item.lastUpdated || null,
    quality: item.quality !== undefined ? item.quality : null,
    source: sourceId,
    rawResource: resource,
  };
}

async function fetchSource(source, maxPages) {
  const records = [];
  let offset = 0;
  let total = Infinity;
  let page = 0;
  while (offset < total && (maxPages == null || page < maxPages)) {
    const url = `${source.base}?limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await politeJson(url);
    if (!res.ok) {
      console.log(`  [${source.id}] page ${page} failed: ${res.error} — stopping pagination`);
      break;
    }
    const items = Array.isArray(res.data.items) ? res.data.items : [];
    const pg = res.data.pagination || {};
    if (typeof pg.total === 'number') total = pg.total;
    for (const it of items) {
      const rec = extractItem(source.id, it);
      if (rec) records.push(rec);
    }
    page++;
    offset += items.length;
    if (page % 25 === 0) console.log(`  [${source.id}] ${records.length} usable / offset ${offset} / total ${total}`);
    if (items.length === 0) break;
  }
  console.log(`  [${source.id}] done: ${records.length} usable records (total reported ${total})`);
  return records;
}

function canonicalKey(rec, opt) {
  return `${rec.url}|${opt.network}|${opt.scheme}`;
}

/** Checkpoint helpers: records appended to data/partial-<source>.jsonl, offset in checkpoint file. */
function loadCheckpoint(outDir, sourceId) {
  const cp = path.join(outDir, `checkpoint-${sourceId}.json`);
  const partial = path.join(outDir, `partial-${sourceId}.jsonl`);
  let offset = 0;
  const records = [];
  const seen = new Set();
  if (fs.existsSync(partial)) {
    for (const line of fs.readFileSync(partial, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        records.push(r);
        for (const opt of r.options) seen.add(canonicalKey(r, opt));
      } catch { /* skip */ }
    }
  }
  if (fs.existsSync(cp)) {
    try { offset = JSON.parse(fs.readFileSync(cp, 'utf8')).nextOffset || 0; } catch { offset = 0; }
  }
  return { offset, records, seen, partial, cp };
}

async function fetchSource(source, maxPages, outDir, pageDelayMs) {
  const { offset: startOffset, records, seen, partial, cp } = loadCheckpoint(outDir, source.id);
  let offset = startOffset;
  let total = Infinity;
  let page = Math.floor(offset / PAGE_LIMIT);
  const pagesDone = maxPages == null ? Infinity : maxPages;
  let pagesRun = 0;
  const out = fs.createWriteStream(partial, { flags: 'a' });
  while (offset < total && pagesRun < pagesDone) {
    const url = `${source.base}?limit=${PAGE_LIMIT}&offset=${offset}`;
    const res = await politeJson(url, pageDelayMs);
    if (!res.ok) {
      console.log(`  [${source.id}] page ${page} failed: ${res.error} — checkpointing and stopping`);
      break;
    }
    const items = Array.isArray(res.data.items) ? res.data.items : [];
    const pg = res.data.pagination || {};
    if (typeof pg.total === 'number') total = pg.total;
    for (const it of items) {
      const rec = extractItem(source.id, it);
      if (rec) { out.write(JSON.stringify(rec) + '\n'); records.push(rec); }
    }
    page++;
    pagesRun++;
    offset += items.length;
    fs.writeFileSync(cp, JSON.stringify({ nextOffset: offset, at: new Date().toISOString() }));
    if (page % 25 === 0) console.log(`  [${source.id}] ${records.length} usable / offset ${offset} / total ${total}`);
    if (items.length === 0) break;
  }
  out.end();
  await new Promise(r => out.on('finish', r));
  if (offset >= total) fs.unlinkSync(cp); // fully consumed: clear resume state
  console.log(`  [${source.id}] done: ${records.length} usable records (total reported ${total})`);
  return { records, seen };
}

async function main() {
  const args = process.argv.slice(2);
  const oIdx = args.indexOf('--out');
  const mIdx = args.indexOf('--max-pages');
  const sIdx = args.indexOf('--source');
  const outDir = oIdx >= 0 ? args[oIdx + 1] : path.join(__dirname, '..', 'data');
  const maxPages = mIdx >= 0 ? Number(args[mIdx + 1]) : null;
  const onlySource = sIdx >= 0 ? args[sIdx + 1] : null;

  fs.mkdirSync(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  // Load existing registry
  const registryPath = path.join(outDir, 'registry.json');
  let registry = {};
  if (fs.existsSync(registryPath)) {
    try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')).resources || {}; } catch { registry = {}; }
  }

  // Fetch all sources (resumable via checkpoints)
  const sources = onlySource ? SOURCES.filter(s => s.id === onlySource) : SOURCES;
  let allRecords = [];
  const seenInPull = new Set();
  for (const s of sources) {
    console.log(`ingesting ${s.name} ...`);
    const { records, seen } = await fetchSource(s, maxPages, outDir, s.id === 'payai' ? 3000 : PAGE_MIN_MS);
    for (const k of seen) seenInPull.add(k);
    allRecords = allRecords.concat(records);
  }

  // Merge into registry with dedupe
  let newKeys = 0, updatedKeys = 0, dupInPull = 0;
  const mergedSeen = new Set();
  for (const rec of allRecords) {
    for (const opt of rec.options) {
      const key = canonicalKey(rec, opt);
      if (mergedSeen.has(key)) { dupInPull++; continue; }
      mergedSeen.add(key);
      const existing = registry[key];
      if (!existing) {
        newKeys++;
        registry[key] = {
          key,
          url: rec.url,
          route: new URL(rec.url).pathname || '/',
          host: rec.host,
          serviceName: rec.serviceName,
          type: rec.type,
          x402Version: rec.x402Version,
          scheme: opt.scheme,
          network: opt.network,
          asset: opt.asset,
          priceBucket: opt.priceBucket,
          payToTrunc: opt.payToTrunc,
          sources: [rec.source],
          extensionsPresent: rec.extensionsPresent,
          description: rec.description,
          tags: rec.tags,
          quality: rec.quality,
          firstSeen: date,
          lastSeen: date,
          lastCatalogUpdated: rec.lastUpdated,
          lastValidated: null,
          status: 'DISCOVERED',
          validationHistory: [],
        };
      } else {
        updatedKeys++;
        existing.lastSeen = date;
        existing.lastCatalogUpdated = rec.lastUpdated || existing.lastCatalogUpdated;
        if (!existing.sources.includes(rec.source)) existing.sources.push(rec.source);
        if (rec.description && !existing.description) existing.description = rec.description;
        if (rec.quality != null) existing.quality = rec.quality;
        existing.priceBucket = opt.priceBucket;
      }
    }
  }

  // Mark entries not seen in this pull as not-current
  const total = Object.keys(registry).length;
  let staleMarked = 0;
  for (const k of Object.keys(registry)) {
    if (!mergedSeen.has(k) && registry[k].lastSeen !== date) {
      registry[k].notInLatestPull = true;
      staleMarked++;
    } else {
      registry[k].notInLatestPull = false;
    }
  }

  fs.writeFileSync(registryPath, JSON.stringify({ generatedAt: now, totalResources: total, resources: registry }, null, 2));

  const pullFile = path.join(outDir, `discovered-${date}${onlySource ? '-' + onlySource : ''}.json`);
  fs.writeFileSync(pullFile, JSON.stringify({
    generatedAt: now,
    sources: sources.map(s => s.id),
    rawRecordCount: allRecords.length,
    uniqueKeys: mergedSeen.size,
    newKeys, updatedKeys, dupInPull, staleMarked, registryTotal: total,
  }, null, 2));

  console.log(`registry: ${total} unique keys (${newKeys} new, ${updatedKeys} updated, ${dupInPull} dupes-in-pull, ${staleMarked} absent-this-pull)`);
  console.log(`wrote ${registryPath} and ${pullFile}`);

  // Clean up partials for processed sources (merge is complete)
  for (const s of sources) {
    const partial = path.join(outDir, `partial-${s.id}.jsonl`);
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
  }
}

main().catch(e => { console.error('fatal:', e.message || e); process.exit(1); });
