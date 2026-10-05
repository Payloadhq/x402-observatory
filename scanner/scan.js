/**
 * Payload X402 Observatory — scanner.
 *
 * Safely probes publicly documented x402 demo endpoints with single GETs.
 * - max 1 request per 2 seconds per host
 * - 10s timeout per request
 * - User-Agent: Payload-X402-Observatory
 * - Never logs full wallet addresses (truncated to 8 chars), tx hashes, or PII
 * - Never submits payments, never sends auth headers
 *
 * Usage: node scan.js [--targets targets.json] [--out ../data]
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
  const host = u.host;
  const since = Date.now() - (lastHit.get(host) || 0);
  if (since < PER_HOST_MIN_MS) await sleep(PER_HOST_MIN_MS - since);
  lastHit.set(host, Date.now());

  return new Promise((resolve) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: { 'user-agent': UA, 'accept': 'application/json, */*' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < MAX_BODY) buf += c; });
      res.on('end', () => resolve({
        ok: true,
        status: res.statusCode,
        headers: res.headers,
        body: buf,
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message || 'request error' }));
    req.end();
  });
}

function truncAddr(a) {
  if (!a || typeof a !== 'string') return null;
  return a.length > 10 ? a.slice(0, 8) + '…' : a;
}

function tryJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function b64json(s) {
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; }
}

/**
 * Parse an x402 challenge from a 402 response.
 * Returns { version, network, asset, amount, payToPresent, parseable, requirementsPresent, notes[] }
 */
function parseChallenge(status, headers, body) {
  const out = {
    version: null, network: null, asset: null, amount: null,
    payToPresent: false, parseable: false, requirementsPresent: false,
    notes: [],
  };
  if (status !== 402) return out;

  const h = {};
  for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];

  // --- v2: PAYMENT-REQUIRED header (base64) or v2 JSON body ---
  const pr = h['payment-required'] || h['x-payment-required'];
  if (pr) {
    const decoded = b64json(Array.isArray(pr) ? pr[0] : pr);
    if (decoded) {
      out.version = 2;
      out.parseable = true;
      const acc = decoded.accepts && decoded.accepts[0];
      if (acc) {
        out.network = acc.network || null;
        out.asset = acc.asset || null;
        out.amount = acc.amount || acc.maxAmountRequired || null;
        out.payToPresent = !!(acc.payTo || acc.recipient);
        out.requirementsPresent = !!(out.network && out.asset && out.amount);
        if (!out.requirementsPresent) out.notes.push('v2 challenge missing network/asset/amount');
      } else {
        out.notes.push('v2 PAYMENT-REQUIRED decoded but no accepts[] entry');
      }
      return out;
    }
    out.notes.push('PAYMENT-REQUIRED header present but not valid base64 JSON');
  }

  const json = tryJson(body);
  if (json) {
    // v2 JSON shape
    const v = json.x402Version || json.x402version || (json.accepts ? 2 : null);
    if (v === 2 || json.accepts) {
      out.version = 2;
      out.parseable = true;
      const acc = json.accepts && json.accepts[0];
      if (acc) {
        out.network = acc.network || null;
        out.asset = acc.asset || null;
        out.amount = acc.amount || acc.maxAmountRequired || null;
        out.payToPresent = !!(acc.payTo || acc.recipient);
        out.requirementsPresent = !!(out.network && out.asset && out.amount);
        if (!out.requirementsPresent) out.notes.push('v2 JSON challenge missing network/asset/amount');
      } else {
        out.notes.push('v2 JSON body has no accepts[] entry');
      }
      return out;
    }
    // v1 JSON shape: paymentRequirements / maxAmountRequired / X-PAYMENT style
    const prq = json.paymentRequirements || json.payment_requirements || json;
    if (prq && (prq.scheme || prq.network || prq.maxAmountRequired || prq.asset || json.error === 'payment required')) {
      out.version = 1;
      out.parseable = true;
      out.network = prq.network || null;
      out.asset = prq.asset || null;
      out.amount = prq.maxAmountRequired || prq.amount || prq.price || null;
      out.payToPresent = !!(prq.payTo || prq.recipient || prq.pay_to);
      out.requirementsPresent = !!(out.network && out.asset && out.amount);
      if (!out.requirementsPresent) out.notes.push('v1 challenge missing network/asset/amount');
      return out;
    }
    // 402 with JSON but no recognizable challenge
    out.notes.push('402 with JSON body but no recognizable x402 challenge fields');
    return out;
  }

  // v1: X-PAYMENT header hint
  if (h['x-payment'] || h['x-payment-required']) {
    out.version = 1;
    out.notes.push('X-PAYMENT style header present but body not parseable as challenge');
    return out;
  }

  out.notes.push('402 with unparseable challenge (non-JSON body, no x402 headers)');
  return out;
}

function parseManifest(body) {
  const json = tryJson(body);
  if (!json) return { parseable: false, fields: [] };
  const fields = [];
  for (const f of ['name', 'description', 'baseUrl', 'payment', 'endpoints', 'routes', 'network', 'asset', 'payTo', 'x402Version', 'version']) {
    if (json[f] !== undefined) fields.push(f);
  }
  return { parseable: true, fields };
}

function classify(target, res, challenge) {
  if (target.isManifest) {
    if (!res.ok) return 'UNREACHABLE';
    if (res.status !== 200) return 'MALFORMED';
    const m = parseManifest(res.body);
    return m.parseable ? 'VALID_MANIFEST' : 'MALFORMED';
  }
  if (!res.ok) return 'UNREACHABLE';
  if (res.status !== 402) return target.expectStatus === res.status ? 'NOT_X402' : 'NOT_X402';
  if (!challenge.parseable) return 'MALFORMED';
  if (challenge.requirementsPresent) return 'VALID_402';
  return 'DEGRADED';
}

async function scanTarget(t) {
  const started = new Date().toISOString();
  const res = await politeGet(t.url);
  const obs = {
    slug: t.slug,
    name: t.name,
    url: t.url,
    source: t.source,
    sourceUrl: t.sourceUrl,
    checkedAt: started,
    reachable: res.ok,
    status: res.ok ? res.status : null,
    error: res.ok ? null : res.error,
  };
  if (res.ok && !t.isManifest) {
    const ch = parseChallenge(res.status, res.headers, res.body);
    obs.x402Version = ch.version;
    obs.network = ch.network;
    obs.asset = ch.asset;
    obs.amount = ch.amount != null ? String(ch.amount) : null;
    obs.payToPresent = ch.payToPresent;
    obs.challengeParseable = ch.parseable;
    obs.requirementsPresent = ch.requirementsPresent;
    obs.notes = ch.notes;
    obs.classification = classify(t, res, ch);
  } else if (res.ok && t.isManifest) {
    const m = parseManifest(res.body);
    obs.manifestParseable = m.parseable;
    obs.manifestFields = m.fields;
    obs.classification = classify(t, res, null);
    obs.notes = [];
  } else {
    obs.classification = 'UNREACHABLE';
    obs.notes = [obs.error || 'unreachable'];
  }
  return obs;
}

async function main() {
  const args = process.argv.slice(2);
  const tIdx = args.indexOf('--targets');
  const oIdx = args.indexOf('--out');
  const targetsFile = tIdx >= 0 ? args[tIdx + 1] : path.join(__dirname, 'targets.json');
  const outDir = oIdx >= 0 ? args[oIdx + 1] : path.join(__dirname, '..', 'data');

  const targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
  console.log(`Observatory scan: ${targets.length} targets, UA=${UA}`);
  const observations = [];
  for (const t of targets) {
    console.log(`  probing ${t.slug} ...`);
    const obs = await scanTarget(t);
    observations.push(obs);
    console.log(`    -> ${obs.classification} (status ${obs.status ?? obs.error})`);
  }

  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `observations-${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scanner: 'Payload-X402-Observatory/1.0',
    observations,
  }, null, 2));
  console.log(`wrote ${outFile}`);

  // aggregate summary
  const counts = {};
  const versions = {};
  const networks = {};
  const assets = {};
  const failures = {};
  for (const o of observations) {
    counts[o.classification] = (counts[o.classification] || 0) + 1;
    if (o.x402Version) versions['v' + o.x402Version] = (versions['v' + o.x402Version] || 0) + 1;
    if (o.network) networks[o.network] = (networks[o.network] || 0) + 1;
    if (o.asset) assets[o.asset] = (assets[o.asset] || 0) + 1;
    for (const n of (o.notes || [])) failures[n] = (failures[n] || 0) + 1;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    endpointsObserved: observations.length,
    classifications: counts,
    versionSplit: versions,
    networkDistribution: networks,
    assetDistribution: assets,
    topFailureModes: Object.entries(failures).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([mode, count]) => ({ mode, count })),
  };
  const apiDir = path.join(__dirname, '..', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('wrote api/summary.json');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error('fatal:', e.message || e); process.exit(1); });
