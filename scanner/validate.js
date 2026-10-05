/**
 * Payload X402 Observatory — validator.
 *
 * Promotes DISCOVERED registry entries to VALIDATED by probing each resource
 * with ONE non-paying GET. Never submits payments, never bypasses auth,
 * never sends auth headers.
 *
 * Queue strategy (each run):
 *   1. Entries never validated before get priority (oldest firstSeen first).
 *   2. Then entries whose lastValidated is older than 24h, recently-updated first.
 *   Skips entries whose URL failed validation with UNREACHABLE more than 3 consecutive times
 *   (they stay DISCOVERED/STALE; rechecked weekly at most).
 *
 * Usage: node scanner/validate.js [--out ../data] [--max N] [--dry]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

const UA = 'Payload-X402-Observatory (+https://payloadhq.github.io/)';
const PER_HOST_MIN_MS = 2000;
const TIMEOUT_MS = 10000;
const MAX_BODY = 65536;

const lastHit = new Map();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function politeGet(url) {
  const u = new URL(url);
  const since = Date.now() - (lastHit.get(u.host) || 0);
  if (since < PER_HOST_MIN_MS) await sleep(PER_HOST_MIN_MS - since);
  lastHit.set(u.host, Date.now());
  const t0 = Date.now();
  return new Promise((resolve) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: { 'user-agent': UA, 'accept': 'application/json, */*' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < MAX_BODY) buf += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: buf, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || 'request error').slice(0, 120), ms: Date.now() - t0 }));
    req.end();
  });
}

function b64json(s) {
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; }
}
function tryJson(b) { try { return JSON.parse(b); } catch { return null; } }

/**
 * Inspect a single live GET response. Returns validation outcome.
 * verdict: VALID_402 | DEGRADED | MALFORMED | NOT_X402 | UNREACHABLE
 */
function inspect(res) {
  if (!res.ok) return { verdict: 'UNREACHABLE', detail: res.error, responseMs: res.ms };
  const h = {};
  for (const k of Object.keys(res.headers)) h[k.toLowerCase()] = res.headers[k];
  if (res.status !== 402) {
    return {
      verdict: 'NOT_X402',
      detail: `HTTP ${res.status} (expected 402 challenge)`,
      responseMs: res.ms,
    };
  }
  // v2: PAYMENT-REQUIRED header
  const pr = h['payment-required'] || h['x-payment-required'];
  let challenge = null, version = null;
  if (pr) {
    const d = b64json(Array.isArray(pr) ? pr[0] : pr);
    if (d) { challenge = d; version = 2; }
  }
  if (!challenge) {
    const j = tryJson(res.body);
    if (j && (j.x402Version === 2 || j.accepts)) { challenge = j; version = 2; }
    else if (j && (j.paymentRequirements || j.payment_requirements || j.error === 'payment required')) {
      challenge = j.paymentRequirements || j.payment_requirements || j; version = 1;
    }
  }
  if (!challenge) {
    return { verdict: 'MALFORMED', detail: '402 without parseable x402 challenge', responseMs: res.ms };
  }
  const accepts = challenge.accepts || [];
  const a = accepts[0] || challenge;
  const network = a.network || null;
  const asset = a.asset || null;
  const amount = a.amount || a.maxAmountRequired || null;
  const complete = !!(network && asset && amount);
  const knownNetwork = network && /^(eip155:\d+|solana:[A-Za-z0-9]+)$/.test(network);
  if (complete && knownNetwork) {
    return {
      verdict: 'VALID_402', detail: null, responseMs: res.ms,
      live: { x402Version: version, network, asset, amount: String(amount), scheme: (a.scheme || '').toLowerCase() || null },
    };
  }
  const problems = [];
  if (!complete) problems.push('challenge missing network/asset/amount');
  if (!knownNetwork) problems.push('unrecognized network format');
  return { verdict: 'DEGRADED', detail: problems.join('; '), responseMs: res.ms };
}

function statusFromVerdict(verdict) {
  switch (verdict) {
    case 'VALID_402': return 'ACTIVE';
    case 'DEGRADED': return 'DEGRADED';
    case 'MALFORMED': return 'DEGRADED';
    case 'NOT_X402': return 'DEGRADED';
    case 'UNREACHABLE': return 'UNREACHABLE';
    default: return 'DISCOVERED';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const oIdx = args.indexOf('--out');
  const mIdx = args.indexOf('--max');
  const dry = args.includes('--dry');
  const outDir = oIdx >= 0 ? args[oIdx + 1] : path.join(__dirname, '..', 'data');
  const max = mIdx >= 0 ? Number(args[mIdx + 1]) : 300;

  const registryPath = path.join(outDir, 'registry.json');
  if (!fs.existsSync(registryPath)) { console.error('no registry.json — run ingest-bazaar.js first'); process.exit(1); }
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const resources = reg.resources || {};
  const keys = Object.keys(resources);
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const dayAgo = now.getTime() - 24 * 3600 * 1000;

  // Build queue
  const never = [], refresh = [];
  for (const k of keys) {
    const r = resources[k];
    if (r.notInLatestPull) continue; // catalog no longer lists it; mark stale instead
    const consecFail = (r.validationHistory || []).slice(-3).filter(h => h.verdict === 'UNREACHABLE').length;
    if (r.lastValidated == null) never.push(r);
    else if (new Date(r.lastValidated).getTime() < dayAgo && consecFail < 3) refresh.push(r);
  }
  never.sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || '') || (b.quality || 0) - (a.quality || 0));
  // Seeded shuffle so the validation sample is representative of the whole catalog
  // (not biased toward whichever source populates `quality`).
  let seed = 20261005;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = never.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [never[i], never[j]] = [never[j], never[i]];
  }
  refresh.sort((a, b) => (b.lastCatalogUpdated || '').localeCompare(a.lastCatalogUpdated || ''));
  const queue = never.concat(refresh).slice(0, max);
  console.log(`queue: ${queue.length} (never-validated ${Math.min(never.length, max)}, refresh ${Math.max(0, Math.min(refresh.length, max - Math.min(never.length, max)))})`);

  const results = [];
  let i = 0;
  for (const r of queue) {
    i++;
    const res = await politeGet(r.url);
    const insp = inspect(res);
    const status = statusFromVerdict(insp.verdict);
    const entry = {
      key: r.key, url: r.url,
      verdict: insp.verdict, status,
      detail: insp.detail,
      responseMs: insp.responseMs,
      live: insp.live || null,
      checkedAt: new Date().toISOString(),
    };
    results.push(entry);
    if (!dry) {
      r.status = status;
      r.lastValidated = entry.checkedAt;
      r.validationHistory = (r.validationHistory || []).concat([{
        date, verdict: insp.verdict, status, responseMs: insp.responseMs, detail: insp.detail,
      }]).slice(-10);
      if (insp.live) {
        r.liveX402Version = insp.live.x402Version;
        r.liveNetwork = insp.live.network;
        r.liveAsset = insp.live.asset;
        r.liveAmount = insp.live.amount;
        r.liveScheme = insp.live.scheme;
        r.metadataConsistent = (
          (r.network == null || r.liveNetwork === r.network) &&
          (r.scheme == null || r.liveScheme === r.scheme || r.liveScheme == null)
        );
      }
    }
    if (i % 25 === 0) {
      console.log(`  validated ${i}/${queue.length} (${insp.verdict})`);
      if (!dry) {
        // Incremental checkpoint so a killed run keeps its work
        const partFile = path.join(outDir, `validated-${date}.partial.json`);
        fs.writeFileSync(partFile, JSON.stringify({
          generatedAt: new Date().toISOString(), partial: true,
          validatedCount: results.length, results,
        }, null, 2));
        fs.writeFileSync(registryPath, JSON.stringify({ ...reg, generatedAt: new Date().toISOString() }, null, 2));
      }
    }
  }

  // Mark entries absent from the latest catalog pull as STALE (if previously ACTIVE/DEGRADED)
  let staleCount = 0;
  if (!dry) {
    for (const k of keys) {
      const r = resources[k];
      if (r.notInLatestPull && (r.status === 'ACTIVE' || r.status === 'DEGRADED' || r.status === 'UNREACHABLE')) {
        r.status = 'STALE';
        staleCount++;
      } else if (r.notInLatestPull && r.status === 'DISCOVERED') {
        r.status = 'STALE';
        staleCount++;
      }
    }
    fs.writeFileSync(registryPath, JSON.stringify({ ...reg, generatedAt: new Date().toISOString() }, null, 2));
    const valFile = path.join(outDir, `validated-${date}.json`);
    fs.writeFileSync(valFile, JSON.stringify({
      generatedAt: new Date().toISOString(),
      validatedCount: results.length,
      results,
    }, null, 2));
    console.log(`wrote ${valFile}; marked ${staleCount} stale`);
  }

  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log(JSON.stringify({ validated: results.length, tally }, null, 2));
}

main().catch(e => { console.error('fatal:', e.message || e); process.exit(1); });
