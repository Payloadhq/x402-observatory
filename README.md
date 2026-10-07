# x402 Observatory

**Public operational health of discoverable x402 resources. By Payload.**

Continuously measured, published data on whether publicly listed x402 resources
actually work: are they reachable, do they return a valid `402`, is the payment
challenge machine-readable. Real scan data only. No estimates, no demo metrics.

**Three numbers, never conflated:** DISCOVERED (listed in a public catalog) ·
VALIDATED (probed once by the Observatory) · ACTIVE (last probe returned a valid 402).

## Explore the data

- **Dashboard:** https://payloadhq.github.io/x402-observatory/
- **Machine-readable APIs:** `api/summary.json`, `api/resources.json` (top 500),
  `api/networks.json`, `api/failures.json`, `api/history.json`
- **Method:** [METHODOLOGY.md](METHODOLOGY.md)

## Run the scanner yourself

```bash
cd scanner
node ingest-bazaar.js   # CDP + PayAI public catalogs → data/registry.json (resumable)
node validate.js        # one non-paying GET per queued resource (default max 300/run)
node build-dashboard.js # dashboard/ + api/*.json + data/snapshots/YYYY-MM-DD.json
```

Polite by design: ≤1 req/2s per host, 10-30s timeouts, identifiable User-Agent.
Never submits payments, never sends credentials, never stress-tests.

## Latest results (2026-10-05)

- **Discovered:** 71,209 catalog entries (CDP 58,949 + PayAI 14,360, deduped) across 2,854 hosts
- **Validated:** 12 (random seeded sample) · **Active:** 8
- Valid-402 rate: 66.7% (n=12) · Failure modes: HTTP 405 ×2, HTTP 200 ×1, HTTP 404 ×1
- Versions: v2 69,756 · v1 1,453 · Networks: Base 39,876, Solana 8,713, Base Sepolia 8,450…
- Price buckets: under-$0.01: 14,468 · $0.01-$0.10: 26,398 · $0.10-$1: 2,153 · unknown: 27,733
- Ecosystem health: INSUFFICIENT_DATA (needs N≥25 validated)

Validation expands with each run; every metric displays its N.

## Where this leads

Building on x402 in production? **Veyline by Payload** is the production layer
for x402 + MCP: autonomous economic control for machine commerce. When a paid
endpoint misbehaves, **callx402 by Payload — powered by Veyline** diagnoses and
rescues broken x402 calls: when x402 breaks, callx402.

## License

This repo ships no LICENSE file. See [Payload](https://payloadhq.github.io/).
