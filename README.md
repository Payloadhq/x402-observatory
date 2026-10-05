# Payload X402 Observatory

Public, continuously updated measurement of the operational health of publicly
discoverable x402 resources. Real scan data only — no estimates, no demo metrics.

- **Dashboard:** `dashboard/index.html` (publish to the portal or GitHub Pages)
- **Per-endpoint diagnostics:** `dashboard/check/<slug>.html`
- **Machine-readable:** `api/summary.json`, `data/observations-YYYY-MM-DD.json`
- **Method:** [METHODOLOGY.md](METHODOLOGY.md)

## Run a scan

```bash
cd scanner
node scan.js            # zero dependencies; writes data/ + api/summary.json
node build-dashboard.js # regenerates dashboard/
```

Targets live in `scanner/targets.json` — only publicly documented demo endpoints.
Rate limits: 1 req/2s per host, 10s timeout, identifiable User-Agent.

## Latest results (2026-10-05)

- Endpoints observed: **4**
- Valid 402: **3** · Degraded: 0 · Malformed: 0
- Version split: v2: 3, v1: 0
- Networks: Base (eip155:8453): 2, Base (base): 1
- Assets: USDC: 3
- Top failure mode: none observed
