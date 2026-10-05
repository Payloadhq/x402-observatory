/**
 * Observatory dashboard builder.
 * Reads data/observations-YYYY-MM-DD.json + api/summary.json,
 * writes dashboard/index.html and dashboard/check/<slug>.html.
 * Every number comes from the actual scan — no invented data.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const API = path.join(ROOT, 'api');
const DASH = path.join(ROOT, 'dashboard');

const KNOWN_ASSETS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
};
const KNOWN_NETWORKS = {
  'eip155:8453': 'Base',
  'base': 'Base',
};

function normAsset(a) {
  if (!a) return '—';
  const low = a.toLowerCase();
  if (KNOWN_ASSETS[low]) return `${KNOWN_ASSETS[low]} (${a.slice(0, 6)}…${a.slice(-4)})`;
  return a.length > 14 ? a.slice(0, 10) + '…' : a;
}
function normNetwork(n) {
  if (!n) return '—';
  return KNOWN_NETWORKS[n.toLowerCase()] ? `${KNOWN_NETWORKS[n.toLowerCase()]} (${n})` : n;
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function latestObservations() {
  const files = fs.readdirSync(DATA).filter(f => f.startsWith('observations-') && f.endsWith('.json')).sort();
  if (!files.length) throw new Error('no observation files');
  return JSON.parse(fs.readFileSync(path.join(DATA, files[files.length - 1]), 'utf8'));
}

function statusOf(o) {
  if (o.classification === 'VALID_402' || o.classification === 'VALID_MANIFEST') return 'PASS';
  if (o.classification === 'DEGRADED') return 'DEGRADED';
  return 'FAIL';
}

function checkRow(label, ok, detail) {
  const mark = ok === true ? '✓' : ok === false ? '✗' : '–';
  const cls = ok === true ? 'ok' : ok === false ? 'bad' : 'na';
  return `<tr><td class="mark ${cls}">${mark}</td><td>${esc(label)}</td><td class="detail">${esc(detail || '')}</td></tr>`;
}

function diagnosticPage(o) {
  const st = statusOf(o);
  const stCls = st === 'PASS' ? 'pass' : st === 'DEGRADED' ? 'degraded' : 'fail';
  const rows = [];
  if (o.isManifest || o.classification === 'VALID_MANIFEST') {
    rows.push(checkRow('endpoint reachable', o.reachable, o.status ? `HTTP ${o.status}` : o.error));
    rows.push(checkRow('manifest parseable', o.manifestParseable, (o.manifestFields || []).join(', ')));
  } else {
    rows.push(checkRow('endpoint reachable', o.reachable, o.status ? `HTTP ${o.status}` : (o.error || '')));
    rows.push(checkRow('returns HTTP 402', o.status === 402, o.status ? `HTTP ${o.status}` : ''));
    rows.push(checkRow('x402 version detected', !!o.x402Version, o.x402Version ? 'v' + o.x402Version : 'none'));
    rows.push(checkRow('challenge parseable', o.challengeParseable === true, ''));
    rows.push(checkRow('payment requirements present', o.requirementsPresent === true,
      [o.network ? 'network: ' + normNetwork(o.network) : null,
       o.asset ? 'asset: ' + normAsset(o.asset) : null,
       o.amount ? 'amount: ' + o.amount : null].filter(Boolean).join(' · ')));
    rows.push(checkRow('payTo present', o.payToPresent === true, ''));
    for (const n of (o.notes || [])) rows.push(checkRow('note', null, n));
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>X402 Check: ${esc(o.name)} — Payload Observatory</title>
<meta name="description" content="Public x402 endpoint diagnostic for ${esc(o.url)}. Operational reachability and challenge-format checks only.">
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#1a1a1a}
.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-weight:700;color:#fff}
.pass{background:#15803d}.degraded{background:#b45309}.fail{background:#b91c1c}
table{width:100%;border-collapse:collapse;margin:16px 0}
td{padding:8px;border-bottom:1px solid #e5e5e5;vertical-align:top}
.mark{font-size:20px;width:36px;text-align:center}
.ok{color:#15803d}.bad{color:#b91c1c}.na{color:#999}
.detail{color:#555;font-size:14px}
.meta{color:#666;font-size:14px}
.cta{background:#f0f6ff;border:1px solid #c7dbff;border-radius:8px;padding:16px;margin-top:24px}
a{color:#1d4ed8}
footer{margin-top:32px;font-size:13px;color:#888}
</style></head><body>
<p><a href="../index.html">← Payload X402 Observatory</a></p>
<h1>X402 Check</h1>
<p><strong>Endpoint:</strong> <code>${esc(o.url)}</code></p>
<p><span class="badge ${stCls}">${st}</span></p>
<table>${rows.join('\n')}</table>
<p class="meta">Last checked: ${esc(o.checkedAt)}<br>
Source: ${esc(o.source)} — <a href="${esc(o.sourceUrl)}">${esc(o.sourceUrl)}</a></p>
<div class="cta">
<h3>Run your own endpoint check</h3>
<p>Check any x402 endpoint from CI with the free
<a href="https://github.com/Payloadhq/x402-manifest-check">x402-manifest-check GitHub Action</a>:</p>
<pre><code>- uses: payloadhq/x402-manifest-check@v1
  with:
    url: https://your-api.example.com/paid-route</code></pre>
<p>Building a paid API? <a href="https://github.com/Payloadhq/x402-paid-api-template">Deploy the x402 Paid API Template</a>
or read the <a href="https://payloadhq.github.io/revrule-api.html">RevRule API reference</a>.</p>
</div>
<footer>This is an operational reachability diagnostic, not a security certification.
Checks use single public GET requests only. See <a href="../index.html#methodology">methodology</a>.</footer>
</body></html>`;
}

function dashboardPage(obs, summary) {
  const c = summary.classifications;
  const ep = obs.observations;
  const rows = ep.map(o => {
    const st = statusOf(o);
    const cls = st === 'PASS' ? 'pass' : st === 'DEGRADED' ? 'degraded' : 'fail';
    return `<tr><td><a href="check/${o.slug}.html">${esc(o.name)}</a></td>
      <td><span class="badge ${cls}">${st}</span></td>
      <td>${o.x402Version ? 'v' + o.x402Version : '—'}</td>
      <td>${esc(normNetwork(o.network))}</td>
      <td>${esc(normAsset(o.asset))}</td></tr>`;
  }).join('\n');

  const verRows = Object.entries(summary.versionSplit).map(([v, n]) => `<tr><td>${esc(v)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="2">none observed</td></tr>';
  const netRows = Object.entries(summary.networkDistribution).map(([n, x]) => `<tr><td>${esc(normNetwork(n))}</td><td>${x}</td></tr>`).join('') || '<tr><td colspan="2">none observed</td></tr>';

  // normalize assets for display (dedupe by lowercase)
  const assetCounts = {};
  for (const o of ep) {
    if (!o.asset) continue;
    const key = o.asset.toLowerCase();
    assetCounts[key] = assetCounts[key] || { raw: o.asset, n: 0 };
    assetCounts[key].n++;
  }
  const assetRows = Object.values(assetCounts).map(a => `<tr><td>${esc(normAsset(a.raw))}</td><td>${a.n}</td></tr>`).join('') || '<tr><td colspan="2">none observed</td></tr>';
  const failRows = summary.topFailureModes.map(f => `<tr><td>${esc(f.mode)}</td><td>${f.count}</td></tr>`).join('') || '<tr><td colspan="2">No failure modes observed in the latest scan.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payload X402 Observatory</title>
<meta name="description" content="Operational health of publicly discoverable x402 resources. Real scan data, updated continuously.">
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:24px;color:#1a1a1a}
.hero{background:#0f172a;color:#fff;border-radius:12px;padding:28px;margin-bottom:24px}
.hero h1{margin:0 0 8px}.hero p{color:#cbd5e1;margin:4px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.stat{border:1px solid #e5e5e5;border-radius:8px;padding:14px;text-align:center}
.stat .n{font-size:32px;font-weight:800}.stat .l{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;margin:12px 0 28px}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#666;padding:8px;border-bottom:2px solid #e5e5e5}
td{padding:8px;border-bottom:1px solid #e5e5e5}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:700;color:#fff;font-size:12px}
.pass{background:#15803d}.degraded{background:#b45309}.fail{background:#b91c1c}
h2{margin-top:36px;border-bottom:2px solid #0f172a;padding-bottom:6px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
a{color:#1d4ed8}
.meta{color:#666;font-size:14px}
footer{margin-top:40px;font-size:13px;color:#888;border-top:1px solid #e5e5e5;padding-top:16px}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}
</style></head><body>
<div class="hero">
<h1>Payload X402 Observatory</h1>
<p>Operational health of publicly discoverable x402 resources — measured, not claimed.</p>
<p class="meta">Last scan: ${esc(summary.generatedAt)} · Scanner: Payload-X402-Observatory/1.0</p>
</div>

<h2>Aggregate</h2>
<div class="grid">
<div class="stat"><div class="n">${summary.endpointsObserved}</div><div class="l">Endpoints observed</div></div>
<div class="stat"><div class="n">${c.VALID_402 || 0}</div><div class="l">Valid 402</div></div>
<div class="stat"><div class="n">${c.DEGRADED || 0}</div><div class="l">Degraded</div></div>
<div class="stat"><div class="n">${c.MALFORMED || 0}</div><div class="l">Malformed</div></div>
<div class="stat"><div class="n">${c.UNREACHABLE || 0}</div><div class="l">Unreachable</div></div>
<div class="stat"><div class="n">${c.NOT_X402 || 0}</div><div class="l">Not x402</div></div>
</div>

<div class="cols">
<div>
<h2>Version split</h2>
<table><tr><th>Version</th><th>Count</th></tr>${verRows}</table>
<h2>Network distribution</h2>
<table><tr><th>Network</th><th>Count</th></tr>${netRows}</table>
</div>
<div>
<h2>Asset distribution</h2>
<table><tr><th>Asset</th><th>Count</th></tr>${assetRows}</table>
<h2>Top failure modes</h2>
<table><tr><th>Mode</th><th>Count</th></tr>${failRows}</table>
</div>
</div>

<h2>Endpoints</h2>
<table><tr><th>Endpoint</th><th>Status</th><th>Version</th><th>Network</th><th>Asset</th></tr>${rows}</table>

<h2 id="methodology">Methodology</h2>
<p>Each target gets a single HTTP GET with a 10-second timeout and an identifiable
<code>User-Agent: Payload-X402-Observatory</code>. At most one request per 2 seconds per host.
We never submit payments, never send credentials, never stress-test, and never log full
wallet addresses. A 402 response is parsed for x402 version (v1: <code>X-PAYMENT</code>/JSON body;
v2: <code>PAYMENT-REQUIRED</code> base64 header or <code>accepts[]</code> JSON), network, asset,
amount, and payTo presence.</p>
<p><strong>Classifications:</strong> VALID_402 (402 + parseable challenge + complete payment requirements);
DEGRADED (402 but requirements incomplete); MALFORMED (402, challenge unparseable);
UNREACHABLE (network error/timeout); NOT_X402 (reachable, no 402).</p>
<p><strong>Sources:</strong> endpoints are only added when publicly documented as demos —
Payload's own public endpoints, the LiquidPad x402 examples README, and the
autonomous-agent-x402-usdc-example README. Full method:
<a href="https://github.com/Payloadhq">METHODOLOGY.md</a> in the observatory repo.
Machine-readable aggregates: <a href="../api/summary.json">api/summary.json</a>.</p>
<p>This is an operational diagnostic, not a security certification.</p>

<footer>Built by <a href="https://payloadhq.github.io/">Payload</a>. Data from live scans;
re-scan to refresh. Questions: see the methodology.</footer>
</body></html>`;
}

function main() {
  const obs = latestObservations();
  const summary = JSON.parse(fs.readFileSync(path.join(API, 'summary.json'), 'utf8'));
  fs.mkdirSync(DASH, { recursive: true });
  fs.mkdirSync(path.join(DASH, 'check'), { recursive: true });
  fs.writeFileSync(path.join(DASH, 'index.html'), dashboardPage(obs, summary));
  for (const o of obs.observations) {
    fs.writeFileSync(path.join(DASH, 'check', o.slug + '.html'), diagnosticPage(o));
  }
  console.log(`dashboard written: index.html + ${obs.observations.length} diagnostic pages`);
}

main();
