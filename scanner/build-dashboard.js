/**
 * Payload X402 Observatory — expanded dashboard/API builder.
 *
 * Reads data/registry.json (+ data/snapshots/) and emits:
 *   dashboard/index.html
 *   api/summary.json, api/resources.json (cap 500), api/networks.json,
 *   api/failures.json, api/history.json
 *   data/snapshots/YYYY-MM-DD.json (daily snapshot for trending)
 *
 * Usage: node scanner/build-dashboard.js [--data ../data] [--dash ../dashboard] [--api ../api]
 *
 * Every aggregate displays its N. DISCOVERED vs VALIDATED vs ACTIVE are three
 * different numbers and are never conflated.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NETWORK_LABELS = {
  'eip155:8453': 'Base', 'eip155:84532': 'Base Sepolia', 'eip155:1': 'Ethereum',
  'eip155:11155111': 'Sepolia', 'eip155:42161': 'Arbitrum', 'eip155:421614': 'Arbitrum Sepolia',
  'eip155:137': 'Polygon', 'eip155:43114': 'Avalanche', 'eip155:43113': 'Avalanche Fuji',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana Devnet',
};
const ASSET_LABELS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', 'epjfwdd5aufqssqem2qn1xzybapc8g4wegkzwytdt1v': 'USDC',
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC', '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC',
};
const KIT_URL = 'https://github.com/Payloadhq/x402-paid-api-template';
const MANIFEST_CHECK_URL = 'https://github.com/Payloadhq/x402-manifest-check';
const CORRECTION_EMAIL = 'kyler.simmons.partners@gmail.com';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function netLabel(n) { return n === 'unknown' ? 'unknown' : (NETWORK_LABELS[n] || n || '—') + (NETWORK_LABELS[n] ? ` (${n})` : ''); }
function assetLabel(a) {
  if (!a || a === 'unknown') return '—';
  const low = String(a).toLowerCase();
  const name = ASSET_LABELS[low];
  return name ? `${name} (${String(a).slice(0, 6)}…${String(a).slice(-4)})` : String(a).slice(0, 14) + '…';
}
function pct(part, whole) { return whole > 0 ? (100 * part / whole).toFixed(1) + '%' : '—'; }
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

function sparkline(values, w, h, color) {
  // Simple SVG line chart. values: [{label, value}] — handles 1-2 points gracefully.
  if (!values.length) return '<p class="meta">No data yet.</p>';
  const max = Math.max(...values.map(v => v.value), 1);
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 8) + 4;
    const y = h - 6 - (v.value / max) * (h - 20);
    return [x, y, v];
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dots = pts.map(([x, y, v]) =>
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"><title>${esc(v.label)}: ${v.value}</title></circle>`).join('');
  const first = esc(values[0].label), last = esc(values[values.length - 1].label);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="trend">
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2"/>
    ${dots}
    <text x="4" y="${h - 1}" font-size="9" fill="#888">${first}</text>
    <text x="${w - 4}" y="${h - 1}" font-size="9" fill="#888" text-anchor="end">${last}</text>
  </svg>`;
}

function main() {
  const args = process.argv.slice(2);
  const g = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const dataDir = g('--data', path.join(__dirname, '..', 'data'));
  const dashDir = g('--dash', path.join(__dirname, '..', 'dashboard'));
  const apiDir = g('--api', path.join(__dirname, '..', 'api'));
  fs.mkdirSync(dashDir, { recursive: true });
  fs.mkdirSync(apiDir, { recursive: true });

  const registryPath = path.join(dataDir, 'registry.json');
  if (!fs.existsSync(registryPath)) { console.error('no registry.json — run ingest-bazaar.js first'); process.exit(1); }
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const resources = Object.values(reg.resources || {});
  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  const weekAgo = daysAgo(7);

  // ---------- Core state counts ----------
  const totalDiscovered = resources.length;
  const validated = resources.filter(r => r.lastValidated != null);
  const totalValidated = validated.length;
  const active = resources.filter(r => r.status === 'ACTIVE');
  const degraded = resources.filter(r => r.status === 'DEGRADED');
  const unreachable = resources.filter(r => r.status === 'UNREACHABLE');
  const stale = resources.filter(r => r.status === 'STALE');
  const discoveredOnly = resources.filter(r => r.status === 'DISCOVERED');

  // Rates are computed over VALIDATED resources only (discovery != validation).
  const verdicts = {};
  for (const r of validated) {
    const v = (r.validationHistory || []).slice(-1)[0];
    const verdict = v ? v.verdict : 'UNKNOWN';
    verdicts[verdict] = (verdicts[verdict] || 0) + 1;
  }
  const valid402 = verdicts['VALID_402'] || 0;
  const valid402Rate = totalValidated ? valid402 / totalValidated : null;
  const degradedRate = totalValidated ? ((verdicts['DEGRADED'] || 0) + (verdicts['MALFORMED'] || 0)) / totalValidated : null;
  const unreachableRate = totalValidated ? (verdicts['UNREACHABLE'] || 0) / totalValidated : null;
  const staleRate = totalDiscovered ? stale.length / totalDiscovered : 0;

  // ---------- Distributions (over the full discovered set) ----------
  const versions = {}, networks = {}, assets = {}, schemes = {}, priceBuckets = {};
  for (const r of resources) {
    versions[r.x402Version ? 'v' + r.x402Version : 'unknown'] =
      (versions[r.x402Version ? 'v' + r.x402Version : 'unknown'] || 0) + 1;
    networks[r.network || 'unknown'] = (networks[r.network || 'unknown'] || 0) + 1;
    assets[r.asset || 'unknown'] = (assets[r.asset || 'unknown'] || 0) + 1;
    schemes[r.scheme || 'unknown'] = (schemes[r.scheme || 'unknown'] || 0) + 1;
    priceBuckets[r.priceBucket || 'unknown'] = (priceBuckets[r.priceBucket || 'unknown'] || 0) + 1;
  }

  // ---------- Failure modes (validated set, latest verdict detail) ----------
  const failures = {};
  for (const r of validated) {
    const v = (r.validationHistory || []).slice(-1)[0];
    if (!v || v.verdict === 'VALID_402') continue;
    const mode = v.verdict === 'UNREACHABLE' ? 'UNREACHABLE: ' + String(v.detail || 'network error').split(':')[0].slice(0, 60)
      : v.verdict + (v.detail ? ': ' + String(v.detail).slice(0, 90) : '');
    failures[mode] = (failures[mode] || 0) + 1;
  }
  const topFailures = Object.entries(failures).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([mode, count]) => ({ mode, count }));

  // ---------- Response latency (latest validation round) ----------
  const latencies = validated
    .map(r => (r.validationHistory || []).slice(-1)[0])
    .filter(v => v && typeof v.responseMs === 'number')
    .map(v => v.responseMs);
  const medianMs = percentile(latencies, 50);
  const p95Ms = percentile(latencies, 95);

  // ---------- New / gone this week ----------
  const newThisWeek = resources.filter(r => (r.firstSeen || '') >= weekAgo).length;
  const goneThisWeek = resources.filter(r => r.status === 'STALE' && (r.lastSeen || '') >= weekAgo).length;

  // ---------- Health (observable metrics only — never a security score) ----------
  let health, healthReason;
  if (totalValidated < 25) {
    health = 'INSUFFICIENT_DATA';
    healthReason = `Only ${totalValidated} resources validated so far; health needs N≥25 validated.`;
  } else if (valid402Rate >= 0.9) {
    health = 'HEALTHY';
    healthReason = `${(valid402Rate * 100).toFixed(1)}% of ${totalValidated} validated resources return a valid 402 challenge (threshold ≥90%).`;
  } else if (valid402Rate >= 0.7) {
    health = 'MIXED';
    healthReason = `${(valid402Rate * 100).toFixed(1)}% of ${totalValidated} validated resources return a valid 402 challenge (70–90%).`;
  } else {
    health = 'DEGRADED';
    healthReason = `Only ${(valid402Rate * 100).toFixed(1)}% of ${totalValidated} validated resources return a valid 402 challenge (<70%).`;
  }

  // ---------- Snapshot (for 7/30/all-time trending) ----------
  const snapDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const snapshot = {
    date, generatedAt: now,
    totalDiscovered, totalValidated, active: active.length,
    valid402Rate: valid402Rate == null ? null : +valid402Rate.toFixed(4),
    degradedRate: degradedRate == null ? null : +degradedRate.toFixed(4),
    unreachableRate: unreachableRate == null ? null : +unreachableRate.toFixed(4),
    staleRate: +staleRate.toFixed(4),
    versions, networks, medianMs, p95Ms,
    newThisWeek, goneThisWeek,
  };
  fs.writeFileSync(path.join(snapDir, `${date}.json`), JSON.stringify(snapshot, null, 2));
  const snapFiles = fs.readdirSync(snapDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const snapshots = snapFiles.map(f => JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')));
  const last7 = snapshots.slice(-7), last30 = snapshots.slice(-30);

  // ---------- Machine-readable APIs ----------
  const summary = {
    generatedAt: now,
    note: 'DISCOVERED = listed in a public catalog. VALIDATED = probed once by the Observatory. ACTIVE = last probe returned a valid 402. These are three different numbers.',
    discovered: totalDiscovered,
    validated: totalValidated,
    active: active.length,
    discoveredOnly: discoveredOnly.length,
    degraded: degraded.length,
    unreachable: unreachable.length,
    stale: stale.length,
    rates: {
      valid402Rate: valid402Rate == null ? null : +valid402Rate.toFixed(4),
      degradedRate: degradedRate == null ? null : +degradedRate.toFixed(4),
      unreachableRate: unreachableRate == null ? null : +unreachableRate.toFixed(4),
      staleRate: +staleRate.toFixed(4),
      validatedShare: totalDiscovered ? +(totalValidated / totalDiscovered).toFixed(4) : 0,
    },
    verdicts,
    versionSplit: versions,
    networkDistribution: networks,
    assetDistribution: assets,
    schemeDistribution: schemes,
    priceBuckets,
    topFailureModes: topFailures,
    latencyMs: { n: latencies.length, median: medianMs, p95: p95Ms },
    newThisWeek, goneThisWeek,
    health: { status: health, reason: healthReason },
    sources: ['cdp', 'payai'],
  };
  fs.writeFileSync(path.join(apiDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // resources.json — cap 500, validated first then quality/recency
  const ranked = [...resources].sort((a, b) => {
    const av = a.lastValidated ? 0 : 1, bv = b.lastValidated ? 0 : 1;
    if (av !== bv) return av - bv;
    return (b.quality || 0) - (a.quality || 0) || String(b.lastCatalogUpdated || '').localeCompare(a.lastCatalogUpdated || '');
  }).slice(0, 500);
  const resourcesApi = ranked.map(r => ({
    url: r.url, host: r.host, serviceName: r.serviceName, type: r.type,
    currentStatus: r.status,
    firstSeen: r.firstSeen, lastSeen: r.lastSeen, lastValidated: r.lastValidated,
    version: r.liveX402Version || r.x402Version,
    network: r.liveNetwork || r.network,
    asset: r.liveAsset ? assetLabel(r.liveAsset) : assetLabel(r.asset),
    priceBucket: r.priceBucket,
    scheme: r.liveScheme || r.scheme,
    sources: r.sources,
    metadataConsistent: r.metadataConsistent == null ? null : r.metadataConsistent,
    history: (r.validationHistory || []).slice(-5).map(h => ({
      date: h.date, verdict: h.verdict, status: h.status, responseMs: h.responseMs,
    })),
  }));
  fs.writeFileSync(path.join(apiDir, 'resources.json'), JSON.stringify({
    generatedAt: now, count: resourcesApi.length, totalInRegistry: totalDiscovered, capped: totalDiscovered > 500,
    note: 'Sorted: validated first, then catalog quality/recency. Full registry available on request.',
    resources: resourcesApi,
  }, null, 2));

  fs.writeFileSync(path.join(apiDir, 'networks.json'), JSON.stringify({
    generatedAt: now, n: totalDiscovered, networks,
  }, null, 2));

  fs.writeFileSync(path.join(apiDir, 'failures.json'), JSON.stringify({
    generatedAt: now, validatedN: totalValidated, verdicts, topFailureModes: topFailures,
    note: 'Failure modes observed from single non-paying GET probes. UNREACHABLE includes DNS/TCP/TLS/timeout errors.',
  }, null, 2));

  fs.writeFileSync(path.join(apiDir, 'history.json'), JSON.stringify({
    generatedAt: now, snapshots: snapshots.length,
    windows: {
      '7d': last7.map(s => ({ date: s.date, totalDiscovered: s.totalDiscovered, valid402Rate: s.valid402Rate })),
      '30d': last30.map(s => ({ date: s.date, totalDiscovered: s.totalDiscovered, valid402Rate: s.valid402Rate })),
      all: snapshots.map(s => ({ date: s.date, totalDiscovered: s.totalDiscovered, valid402Rate: s.valid402Rate })),
    },
  }, null, 2));

  // ---------- Dashboard HTML ----------
  const rows = (obj, labelFn) => Object.entries(obj).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(labelFn ? labelFn(k) : k)}</td><td>${v.toLocaleString()}</td><td>${pct(v, totalDiscovered)}</td></tr>`).join('');

  const healthClass = health === 'HEALTHY' ? 'pass' : health === 'DEGRADED' ? 'fail' : 'degraded';
  const healthNote = 'Ecosystem health is computed from observable probe metrics only (valid-402 rate). It is not a security score. See METHODOLOGY.md.';

  const serviceRows = ranked.slice(0, 120).map(r => {
    const v = (r.validationHistory || []).slice(-1)[0];
    const badge = r.status === 'ACTIVE' ? '<span class="badge pass">ACTIVE</span>'
      : r.status === 'DEGRADED' ? '<span class="badge degraded">DEGRADED</span>'
      : r.status === 'UNREACHABLE' ? '<span class="badge fail">UNREACHABLE</span>'
      : r.status === 'STALE' ? '<span class="badge stale">STALE</span>'
      : '<span class="badge disc">DISCOVERED</span>';
    const cta = (v && (v.verdict === 'DEGRADED' || v.verdict === 'MALFORMED'))
      ? `<br><a data-cta="manifest-check" href="${MANIFEST_CHECK_URL}">Run this configuration through Payload x402 Manifest Check</a>`
      : '';
    const net = r.liveNetwork || r.network || '—';
    return `<tr><td><code>${esc(r.host)}</code><br><span class="meta">${esc(r.url.slice(0, 90))}${r.url.length > 90 ? '…' : ''}</span>${cta}</td>` +
      `<td>${badge}</td><td>${r.liveX402Version || r.x402Version ? 'v' + (r.liveX402Version || r.x402Version) : '—'}</td>` +
      `<td>${esc(net === '—' ? '—' : (NETWORK_LABELS[net] ? NETWORK_LABELS[net] + ' (' + net + ')' : net))}</td>` +
      `<td>${esc(r.priceBucket || '—')}</td>` +
      `<td>${esc(r.firstSeen || '—')}<br><span class="meta">seen ${esc(r.lastSeen || '—')}${r.lastValidated ? '<br>validated ' + esc(r.lastValidated.slice(0, 10)) : ''}</span></td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payload X402 Observatory</title>
<meta name="description" content="Operational health of publicly discoverable x402 resources. Real scan data, updated continuously.">
<!-- INSTRUMENTATION PLAN (not yet instrumented — no tracking backend built):
     1. All CTA links carry data-cta="<slug>" attributes.
     2. A future ~5-line JS snippet can attach click listeners on [data-cta] and
        POST {cta, page, ts} to a privacy-respecting count endpoint (no cookies, no IP storage).
     3. Dashboard pageviews: GitHub Pages exposes no analytics; when the dashboard
        moves behind the rail, log hourly-bucketed pageview counts (same privacy model as
        rail/src/analytics.ts: no IPs, no user agents, no payloads).
     Until then: OBSERVATORY TRAFFIC = not yet instrumented; CTA CLICKS = not yet instrumented. -->
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:1080px;margin:0 auto;padding:24px;color:#1a1a1a}
.hero{background:#0f172a;color:#fff;border-radius:12px;padding:28px;margin-bottom:24px}
.hero h1{margin:0 0 8px}.hero p{color:#cbd5e1;margin:4px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.stat{border:1px solid #e5e5e5;border-radius:8px;padding:14px;text-align:center}
.stat .n{font-size:32px;font-weight:800}.stat .l{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;margin:12px 0 28px;font-size:14px}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#666;padding:8px;border-bottom:2px solid #e5e5e5}
td{padding:8px;border-bottom:1px solid #e5e5e5;vertical-align:top}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:700;color:#fff;font-size:12px}
.pass{background:#15803d}.degraded{background:#b45309}.fail{background:#b91c1c}.stale{background:#64748b}.disc{background:#334155}
h2{margin-top:36px;border-bottom:2px solid #0f172a;padding-bottom:6px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
a{color:#1d4ed8}
.meta{color:#666;font-size:13px}
footer{margin-top:40px;font-size:13px;color:#888;border-top:1px solid #e5e5e5;padding-top:16px}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
.cta-box{border:1px solid #bfdbfe;background:#eff6ff;border-radius:8px;padding:12px 16px;margin:20px 0;font-size:14px}
.warn{border:1px solid #fde68a;background:#fffbeb;border-radius:8px;padding:12px 16px;margin:20px 0;font-size:14px}
</style></head><body>
<div class="hero">
<h1>Payload X402 Observatory</h1>
<p>Operational health of publicly discoverable x402 resources — measured, not claimed.</p>
<p class="meta">Snapshot: ${esc(now)} · Registry: ${reg.generatedAt ? esc(String(reg.generatedAt).slice(0, 10)) : '—'} · Snapshots: ${snapshots.length}</p>
</div>

<div class="warn"><strong>Three different numbers:</strong> DISCOVERED = listed in a public catalog ·
VALIDATED = probed once by the Observatory · ACTIVE = last probe returned a valid 402 challenge.
A catalog listing is never presented as proof that a resource works.</div>

<h2>Headline metrics</h2>
<div class="grid">
<div class="stat"><div class="n">${totalDiscovered.toLocaleString()}</div><div class="l">Discovered</div></div>
<div class="stat"><div class="n">${totalValidated.toLocaleString()}</div><div class="l">Validated</div></div>
<div class="stat"><div class="n">${active.length.toLocaleString()}</div><div class="l">Active</div></div>
<div class="stat"><div class="n">${valid402Rate == null ? '—' : (valid402Rate * 100).toFixed(1) + '%'}</div><div class="l">Valid-402 rate (n=${totalValidated.toLocaleString()})</div></div>
<div class="stat"><div class="n">${degraded.length.toLocaleString()}</div><div class="l">Degraded</div></div>
<div class="stat"><div class="n">${unreachable.length.toLocaleString()}</div><div class="l">Unreachable</div></div>
<div class="stat"><div class="n">${stale.length.toLocaleString()}</div><div class="l">Stale</div></div>
<div class="stat"><div class="n">${medianMs == null ? '—' : medianMs + 'ms'}</div><div class="l">Median response (n=${latencies.length.toLocaleString()})</div></div>
<div class="stat"><div class="n">${p95Ms == null ? '—' : p95Ms + 'ms'}</div><div class="l">P95 response</div></div>
<div class="stat"><div class="n">${newThisWeek.toLocaleString()}</div><div class="l">New this week</div></div>
<div class="stat"><div class="n">${goneThisWeek.toLocaleString()}</div><div class="l">Gone this week</div></div>
</div>

<h2>Ecosystem health: <span class="badge ${healthClass}">${health}</span></h2>
<p>${esc(healthReason)}</p>
<p class="meta">${healthNote}</p>

<h2>Trends</h2>
<div class="cols">
<div><h3>Resources discovered (all time, ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'})</h3>
${sparkline(snapshots.map(s => ({ label: s.date, value: s.totalDiscovered })), 320, 120, '#1d4ed8')}</div>
<div><h3>Valid-402 rate (all time)</h3>
${sparkline(snapshots.map(s => ({ label: s.date, value: s.valid402Rate == null ? 0 : +(s.valid402Rate * 100).toFixed(1) })), 320, 120, '#15803d')}</div>
</div>

<div class="cols">
<div>
<h2>Version split (n=${totalDiscovered.toLocaleString()})</h2>
<table><tr><th>Version</th><th>Count</th><th>Share</th></tr>${rows(versions)}</table>
<h2>Scheme distribution (n=${totalDiscovered.toLocaleString()})</h2>
<table><tr><th>Scheme</th><th>Count</th><th>Share</th></tr>${rows(schemes)}</table>
<h2>Price buckets (n=${totalDiscovered.toLocaleString()})</h2>
<table><tr><th>Bucket</th><th>Count</th><th>Share</th></tr>${rows(priceBuckets)}</table>
</div>
<div>
<h2>Network distribution (n=${totalDiscovered.toLocaleString()})</h2>
<table><tr><th>Network</th><th>Count</th><th>Share</th></tr>${rows(networks, (k) => netLabel(k))}</table>
<h2>Asset distribution (n=${totalDiscovered.toLocaleString()})</h2>
<table><tr><th>Asset</th><th>Count</th><th>Share</th></tr>${rows(assets, (k) => assetLabel(k))}</table>
</div>
</div>

<h2>Top failure modes (validated n=${totalValidated.toLocaleString()})</h2>
<table><tr><th>Mode</th><th>Count</th></tr>
${topFailures.length ? topFailures.map(f => `<tr><td><code>${esc(f.mode)}</code></td><td>${f.count}</td></tr>`).join('') : '<tr><td colspan="2">No failures observed among validated resources.</td></tr>'}
</table>

<h2>Resources (showing ${Math.min(120, ranked.length).toLocaleString()} of ${totalDiscovered.toLocaleString()})</h2>
<p class="meta">Statuses: ACTIVE = last probe returned a valid 402 · DEGRADED = 402 but challenge incomplete/unparseable ·
UNREACHABLE = network error · STALE = no longer in the source catalog · DISCOVERED = not yet probed.
To request a correction or removal, contact <a href="mailto:${CORRECTION_EMAIL}">${CORRECTION_EMAIL}</a>.
Listing here implies no endorsement or ownership.</p>
<div class="cta-box">Operate one of these endpoints? <a data-cta="monitor" href="${KIT_URL}">Monitor your endpoint with Payload</a> ·
Building x402 payments? <a data-cta="tooling" href="${KIT_URL}">Use the Payload x402 production tooling</a></div>
<table><tr><th>Resource</th><th>Status</th><th>Ver</th><th>Network</th><th>Price</th><th>History</th></tr>
${serviceRows || '<tr><td colspan="6">No resources yet.</td></tr>'}
</table>

<h2 id="methodology">Methodology</h2>
<p><strong>Discovery:</strong> we consume only public, unauthenticated catalog endpoints —
CDP x402 Bazaar (<code>api.cdp.coinbase.com/platform/v2/x402/discovery/resources</code>) and
PayAI Bazaar (<code>facilitator.payai.network/discovery/resources</code>), paginated at max
1 request per 2 seconds. payTo addresses are truncated to 10 chars; amounts are reported
as price buckets only.</p>
<p><strong>Validation:</strong> each resource gets at most one non-paying HTTP GET per day
(10s timeout, identifiable User-Agent). We never submit payments, never send credentials,
never stress-test. A 402 response is parsed for x402 version, network, asset, amount, and
payTo presence. Resources absent from a fresh catalog pull are marked STALE, not deleted.</p>
<p><strong>Verdicts:</strong> VALID_402 (402 + parseable challenge + complete requirements);
DEGRADED (402 but incomplete/unparseable); UNREACHABLE (network error/timeout);
NOT_X402 (reachable, no 402). Health = valid-402 rate over validated resources:
≥90% HEALTHY, 70–90% MIXED, &lt;70% DEGRADED; N&lt;25 → INSUFFICIENT_DATA.
This is an operational diagnostic, <strong>not a security score</strong>.</p>
<p>Full method: <a href="https://github.com/Payloadhq/x402-observatory/blob/main/METHODOLOGY.md">METHODOLOGY.md</a> ·
Machine-readable: <a href="../api/summary.json">summary</a> · <a href="../api/resources.json">resources</a> ·
<a href="../api/networks.json">networks</a> · <a href="../api/failures.json">failures</a> · <a href="../api/history.json">history</a>.</p>

<footer>Built by <a href="https://payloadhq.github.io/">Payload</a>. Data from live catalog pulls and probes;
re-run ingestion + validation to refresh. Questions or corrections: <a href="mailto:${CORRECTION_EMAIL}">${CORRECTION_EMAIL}</a>.</footer>
</body></html>`;

  fs.writeFileSync(path.join(dashDir, 'index.html'), html);
  console.log(`dashboard: ${totalDiscovered} discovered, ${totalValidated} validated, ${active.length} active`);
  console.log(`apis written to ${apiDir}; snapshot ${date}.json; snapshots on file: ${snapshots.length}`);
}

main();
