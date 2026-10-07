> **Payload** — Developer infrastructure for x402, agent payments, and programmable revenue.
> PAYLOAD → VEYLINE (flagship) → CALLX402 (action layer) → REVRULE (separate) → developer products → free utilities.
> This repo: **X402 Observatory by Payload — public operational health of discoverable x402 resources.**

<p align="center"><img src="docs/logo.png" alt="x402-observatory logo" width="200"></p>
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
node validate.js        # one method-aware non-paying probe per queued resource (default batch 200/run)
node build-dashboard.js # dashboard/ + api/*.json + data/snapshots/YYYY-MM-DD.json
```

Polite by design: ingest runs ≤1 req/2s per host with 30s timeouts; validation
runs ≤1 req/host/5min with 10s timeouts; identifiable User-Agent throughout.
Never submits payments, never sends credentials, never stress-tests.

## Latest results (2026-10-05)

- **Discovered:** 71,259 resources (CDP 35,011 + PayAI 14,515 listings seen, deduped)
- **Validated:** 12 (seeded sample; 11 applicable, 1 MCP-type entry excluded) · **Active:** 11
- Valid-402 rate: 100% of applicable probes (11/11) · Failure modes: none among applicable probes this run
- Versions: v2 69,806 · v1 1,453 · Networks: Base 39,897, Solana 8,726, Base Sepolia 8,451…
- Price buckets: under-$0.01: 14,514 · $0.01-$0.10: 26,393 · $0.10-$1: 2,133 · $1-$10: 390 · over-$10: 70 · unknown: 27,759
- Ecosystem health: INSUFFICIENT_DATA (needs N≥25 validated)

Validation expands with each run; every metric displays its N.

## Where this leads

Building on x402 in production? **Veyline by Payload** is the production layer
for x402 + MCP: autonomous economic control for machine commerce. When a paid
endpoint misbehaves, **callx402 by Payload — powered by Veyline** diagnoses and
rescues broken x402 calls: when x402 breaks, callx402.

## License

This repo ships no LICENSE file. See [Payload](https://payloadhq.github.io/).
