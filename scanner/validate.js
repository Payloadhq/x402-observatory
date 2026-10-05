/**
 * Payload X402 Observatory — validator (methodology v2).
 *
 * Promotes DISCOVERED registry entries to VALIDATED with method-aware,
 * low-frequency, non-paying probes.
 *
 * METHODOLOGY (see METHODOLOGY.md for the full rationale):
 *  1. Probe method = the HTTP method declared in Bazaar discovery metadata
 *     (`method` / `extensions.bazaar.info.input.method`), else GET.
 *  2. Never submit payment, credentials, or auth headers. POST probes use an
 *     empty JSON body and stop at the first response — a well-behaved x402
 *     server answers 402 before executing anything.
 *  3. GET returning 405 does NOT mean the endpoint is broken. If the server's
 *     Allow header (or the catalog's declared method) says POST, one POST
 *     probe is made. Otherwise the verdict is METADATA_MISMATCH: the catalog
 *     listing is inconsistent with live behavior — a discovery problem, not
 *     an endpoint failure.
 *  4. type=mcp resources are not HTTP-probed; validation is NOT_APPLICABLE.
 *  5. Unsafe methods (DELETE, PUT, PATCH...) are never probed.
 *
 * ROTATING VALIDATION:
 *  --batch N --seed S : stratified sample of N from the never-validated queue
 *     (strata: network x discovery-source x x402-version x price-bucket),
 *     hosts spread (max 1 per host per run), seeded-shuffled for reproducibility.
 *  Queue persists in data/validation-queue.json (resumable).
 *  Host-aware politeness: max 1 request per host per 5 minutes, sequential
 *     probing (concurrency 1), identifiable User-Agent. Opt-outs honored from
 *     data/opt-out.json.
 *
 * Usage:
 *   node scanner/validate.js [--out ../data] [--batch N] [--seed S] [--keys k1,k2] [--dry]
 *
 * Verdicts: VALID_402 | DEGRADED | NOT_APPLICABLE | UNREACHABLE
 * Statuses: ACTIVE | DEGRADED | DISCOVERED | UNREACHABLE | STALE
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

const UA = 'Payload-X402-Observatory (+https://payloadhq.github.io/x402-observatory/)';
const PER_HOST_MIN_MS = 300000; // max 1 request per host per 5 minutes
const MAX_PER_HOST_PER_RUN = 1;
const TIMEOUT_MS = 10000;
const MAX_BODY = 65536;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'POST']);
const REVALIDATE_AFTER_DAYS = 7;

const lastHit = new Map();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function politeRequest(url, method, body) {
  const u = new URL(url);
  const since = Date.now() - (lastHit.get(u.host) || 0);
  if (since < PER_HOST_MIN_MS) await sleep(PER_HOST_MIN_MS - since);
  lastHit.set(u.host, Date.now());
  const t0 = Date.now();
  return new Promise((resolve) => {
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { 'user-agent': UA, 'accept': 'application/json, */*' };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    const req = lib.request(u, { method, headers, timeout: TIMEOUT_MS }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < MAX_BODY) buf += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: buf, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || 'request error').slice(0, 120), ms: Date.now() - t0 }));
    if (payload) req.write(payload);
    req.end();
  });
}

function b64json(s) {
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; }
}
function tryJson(b) { try { return JSON.parse(b); } catch { return null; } }

/** Classify a live challenge response. */
function inspectChallenge(res) {
  const h = {};
  for (const k of Object.keys(res.headers)) h[k.toLowerCase()] = res.headers[k];
  if (res.status !== 402) return null;
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
  return challenge ? { challenge, version } : { malformed: true };
}

function checkCompleteness(challenge) {
  const accepts = challenge.accepts || [];
  const a = accepts[0] || challenge;
  const network = a.network || null;
  const asset = a.asset || null;
  const amount = a.amount || a.maxAmountRequired || null;
  const complete = !!(network && asset && amount);
  const knownNetwork = network && /^(eip155:\d+|solana:[A-Za-z0-9]+)$/.test(network);
  return { complete, knownNetwork, live: { network, asset, amount: amount != null ? String(amount) : null, scheme: (a.scheme || '').toLowerCase() || null } };
}

/**
 * Probe one resource. Returns {verdict, failureMode, detail, responseMs, live, methodUsed}.
 * verdict: VALID_402 | DEGRADED | NOT_APPLICABLE | UNREACHABLE
 */
async function probe(r) {
  if ((r.type || 'http') !== 'http') {
    return { verdict: 'NOT_APPLICABLE', failureMode: 'MCP_TYPE', detail: `type=${r.type}: HTTP probing does not apply`, responseMs: 0, methodUsed: null };
  }
  const declared = (r.declaredMethod || 'GET').toUpperCase();
  if (!SAFE_METHODS.has(declared)) {
    return { verdict: 'NOT_APPLICABLE', failureMode: 'UNSAFE_METHOD', detail: `declared method ${declared} is never probed`, responseMs: 0, methodUsed: null };
  }

  const res = await politeRequest(r.url, declared, declared === 'POST' ? {} : null);
  if (!res.ok) return { verdict: 'UNREACHABLE', failureMode: 'CONN_ERROR', detail: res.error, responseMs: res.ms, methodUsed: declared };

  const ch = inspectChallenge(res);
  if (ch && !ch.malformed) {
    const { complete, knownNetwork, live } = checkCompleteness(ch.challenge);
    if (complete && knownNetwork) {
      return { verdict: 'VALID_402', failureMode: null, detail: null, responseMs: res.ms, methodUsed: declared, live: { ...live, x402Version: ch.version } };
    }
    const problems = [];
    if (!complete) problems.push('challenge missing network/asset/amount');
    if (!knownNetwork) problems.push('unrecognized network format');
    return { verdict: 'DEGRADED', failureMode: 'INCOMPLETE_CHALLENGE', detail: problems.join('; '), responseMs: res.ms, methodUsed: declared };
  }

  // Non-402 responses: diagnose carefully, do not assume failure.
  if (res.status === 402) {
    return { verdict: 'DEGRADED', failureMode: 'MALFORMED_CHALLENGE', detail: '402 without parseable x402 challenge', responseMs: res.ms, methodUsed: declared };
  }
  if (res.status === 405 && declared === 'GET') {
    // Server refuses GET. If it documents POST (Allow header), try ONE non-paying POST.
    const allow = String(res.headers['allow'] || '').toUpperCase();
    if (allow.includes('POST')) {
      const p2 = await politeRequest(r.url, 'POST', {});
      if (!p2.ok) return { verdict: 'UNREACHABLE', failureMode: 'CONN_ERROR', detail: p2.error, responseMs: p2.ms, methodUsed: 'POST' };
      const ch2 = inspectChallenge(p2);
      if (ch2 && !ch2.malformed) {
        const { complete, knownNetwork, live } = checkCompleteness(ch2.challenge);
        if (complete && knownNetwork) {
          return { verdict: 'VALID_402', failureMode: null, detail: 'method resolved via Allow header', responseMs: p2.ms, methodUsed: 'POST', live: { ...live, x402Version: ch2.version } };
        }
      }
      return { verdict: 'DEGRADED', failureMode: 'METADATA_MISMATCH', detail: `GET refused (405); POST probed per Allow header, no valid 402 (HTTP ${p2.status})`, responseMs: p2.ms, methodUsed: 'POST' };
    }
    return { verdict: 'DEGRADED', failureMode: 'METADATA_MISMATCH', detail: 'GET refused (405); catalog lists no usable method', responseMs: res.ms, methodUsed: declared };
  }
  if (res.status === 404) {
    return { verdict: 'DEGRADED', failureMode: 'ROUTE_NOT_FOUND', detail: 'HTTP 404: route absent; catalog listing is stale', responseMs: res.ms, methodUsed: declared };
  }
  if (res.status === 200) {
    return { verdict: 'DEGRADED', failureMode: 'CHALLENGE_MISSING', detail: 'HTTP 200 without payment: x402 not enforced', responseMs: res.ms, methodUsed: declared };
  }
  return { verdict: 'DEGRADED', failureMode: 'UNEXPECTED_STATUS', detail: `HTTP ${res.status} (expected 402 challenge)`, responseMs: res.ms, methodUsed: declared };
}

function statusFromVerdict(verdict) {
  switch (verdict) {
    case 'VALID_402': return 'ACTIVE';
    case 'DEGRADED': return 'DEGRADED';
    case 'UNREACHABLE': return 'UNREACHABLE';
    case 'NOT_APPLICABLE': return 'DISCOVERED'; // remains discovered-only; not operationally tested
    default: return 'DISCOVERED';
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stratifySample(pool, n, seed) {
  // Strata: network | source | x402Version | priceBucket. Spread hosts: max 1 per host per run.
  const groups = new Map();
  for (const r of pool) {
    const g = `${r.network || 'unknown'}|${(r.sources || ['?']).slice().sort().join('+')}|v${r.x402Version || '?'}|${r.priceBucket || 'unknown'}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const rand = mulberry(seed);
  const groupArr = [...groups.values()];
  for (const g of groupArr) {
    for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [g[i], g[j]] = [g[j], g[i]]; }
  }
  const sample = [];
  const hostsUsed = new Set();
  const perGroup = new Array(groupArr.length).fill(0);
  let remaining = n, guard = 0;
  while (remaining > 0 && guard++ < n * 50) {
    let progressed = false;
    for (let gi = 0; gi < groupArr.length && remaining > 0; gi++) {
      const g = groupArr[gi];
      while (perGroup[gi] < g.length && hostsUsed.has(g[perGroup[gi]].host)) perGroup[gi]++;
      if (perGroup[gi] < g.length) {
        const r = g[perGroup[gi]++];
        hostsUsed.add(r.host);
        sample.push(r);
        remaining--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return sample;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const outDir = opt('--out', path.join(__dirname, '..', 'data'));
  const batch = Number(opt('--batch', '200'));
  const seed = Number(opt('--seed', String(new Date().toISOString().slice(0, 10).replace(/-/g, ''))));
  const dry = args.includes('--dry');
  const keysArg = opt('--keys', null);
  const date = new Date().toISOString().slice(0, 10);

  const registryPath = path.join(outDir, 'registry.json');
  if (!fs.existsSync(registryPath)) { console.error('no registry.json — run ingest-bazaar.js first'); process.exit(1); }
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const resources = reg.resources || {};
  const keys = Object.keys(resources);

  const optOut = new Set();
  const optOutPath = path.join(outDir, 'opt-out.json');
  if (fs.existsSync(optOutPath)) {
    try { for (const h of JSON.parse(fs.readFileSync(optOutPath, 'utf8')).hosts || []) optOut.add(String(h).toLowerCase()); } catch { /* ignore */ }
  }

  const dayMs = 24 * 3600 * 1000;
  const nowMs = Date.now();
  const never = [], refresh = [];
  for (const k of keys) {
    const r = resources[k];
    if (r.notInLatestPull) continue;
    if (optOut.has((r.host || '').toLowerCase())) continue;
    const consecFail = (r.validationHistory || []).slice(-3).filter(h => h.verdict === 'UNREACHABLE').length;
    if (r.lastValidated == null) never.push(r);
    else if (nowMs - new Date(r.lastValidated).getTime() > REVALIDATE_AFTER_DAYS * dayMs && consecFail < 3) refresh.push(r);
  }

  let queue;
  if (keysArg) {
    queue = keysArg.split(',').map(k => resources[k.trim()]).filter(Boolean);
    console.log(`explicit keys: ${queue.length}`);
  } else {
    // Resumable queue: same seed+date continues where it stopped.
    const qPath = path.join(outDir, 'validation-queue.json');
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(qPath, 'utf8'));
      if (saved.seed !== seed || saved.date !== date) saved = null;
    } catch { saved = null; }
    if (saved && saved.cursor < saved.batch.length) {
      queue = saved.batch.slice(saved.cursor).map(k => resources[k]).filter(Boolean);
      console.log(`resuming queue: ${queue.length} remaining (seed ${seed})`);
    } else {
      const sampled = stratifySample(never, batch, seed);
      const refreshN = Math.min(refresh.length, Math.floor(batch * 0.2));
      queue = sampled.concat(refresh.slice(0, refreshN));
      fs.writeFileSync(qPath, JSON.stringify({ date, seed, batch: queue.map(r => r.key), cursor: 0, savedAt: new Date().toISOString() }, null, 2));
      console.log(`new stratified queue: ${queue.length} (never ${sampled.length}, refresh ${refreshN}; strata from ${never.length} never-validated)`);
    }
  }

  const results = [];
  const qPath = path.join(outDir, 'validation-queue.json');
  let done = 0;
  for (const r of queue) {
    done++;
    const p = await probe(r);
    const status = statusFromVerdict(p.verdict);
    const entry = {
      key: r.key, url: r.url,
      verdict: p.verdict, failureMode: p.failureMode, status,
      detail: p.detail, responseMs: p.responseMs, methodUsed: p.methodUsed,
      live: p.live || null,
      checkedAt: new Date().toISOString(),
    };
    results.push(entry);
    if (!dry) {
      if (p.verdict !== 'NOT_APPLICABLE') {
        r.status = status;
        r.lastValidated = entry.checkedAt;
        r.validationHistory = (r.validationHistory || []).concat([{
          date, verdict: p.verdict, failureMode: p.failureMode, status,
          responseMs: p.responseMs, detail: p.detail, methodUsed: p.methodUsed,
        }]).slice(-10);
      } else {
        r.lastValidated = entry.checkedAt;
        r.validationHistory = (r.validationHistory || []).concat([{
          date, verdict: p.verdict, failureMode: p.failureMode, status: 'DISCOVERED',
          responseMs: p.responseMs, detail: p.detail, methodUsed: p.methodUsed,
        }]).slice(-10);
        // status stays DISCOVERED: not operationally tested
      }
      if (p.live) {
        r.liveX402Version = p.live.x402Version;
        r.liveNetwork = p.live.network;
        r.liveAsset = p.live.asset;
        r.liveAmount = p.live.amount;
        r.liveScheme = p.live.scheme;
        r.metadataConsistent = (
          (r.network == null || r.liveNetwork === r.network) &&
          (r.scheme == null || r.liveScheme === r.scheme || r.liveScheme == null)
        );
      }
    }
    if (!keysArg) {
      try {
        const q = JSON.parse(fs.readFileSync(qPath, 'utf8'));
        q.cursor = (q.cursor || 0) + 1;
        q.savedAt = new Date().toISOString();
        fs.writeFileSync(qPath, JSON.stringify(q, null, 2));
      } catch { /* queue file may not exist for --keys runs */ }
    }
    if (done % 25 === 0) {
      console.log(`  probed ${done}/${queue.length} (${p.verdict}${p.failureMode ? '/' + p.failureMode : ''})`);
      if (!dry) fs.writeFileSync(registryPath, JSON.stringify({ ...reg, generatedAt: new Date().toISOString() }, null, 2));
    }
  }

  if (!dry) {
    let staleCount = 0;
    for (const k of keys) {
      const r = resources[k];
      if (r.notInLatestPull && r.status !== 'STALE' && r.status !== 'DISCOVERED') { r.status = 'STALE'; staleCount++; }
    }
    fs.writeFileSync(registryPath, JSON.stringify({ ...reg, generatedAt: new Date().toISOString() }, null, 2));
    const valFile = path.join(outDir, `validated-${date}.json`);
    let existing = { results: [] };
    if (fs.existsSync(valFile)) { try { existing = JSON.parse(fs.readFileSync(valFile, 'utf8')); } catch { /* */ } }
    existing.results = (existing.results || []).concat(results);
    existing.generatedAt = new Date().toISOString();
    existing.validatedCount = existing.results.length;
    fs.writeFileSync(valFile, JSON.stringify(existing, null, 2));
    console.log(`wrote ${valFile}; marked ${staleCount} stale`);
  }

  const tally = {};
  for (const r of results) tally[`${r.verdict}${r.failureMode ? '/' + r.failureMode : ''}`] = (tally[`${r.verdict}${r.failureMode ? '/' + r.failureMode : ''}`] || 0) + 1;
  console.log(JSON.stringify({ probed: results.length, tally }, null, 2));
}

main().catch(e => { console.error('fatal:', e.message || e); process.exit(1); });
