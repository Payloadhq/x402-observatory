# Payload X402 Observatory — Methodology

**Version:** 1.0 · **First scan:** 2026-10-05
**Scanner:** `scanner/scan.js` (zero-dependency Node.js) · **UA:** `Payload-X402-Observatory (+https://payloadhq.github.io/)`

## What this is

A public, continuously updated measurement of the operational health of publicly
discoverable x402 resources. Every number on the dashboard comes from an actual
scan run. No estimates, no demo metrics.

## What we do

For each target endpoint, exactly one HTTP GET:

1. Record reachability, HTTP status, response headers, body (first 64 KB).
2. If status is 402, parse the x402 challenge:
   - **v2:** `PAYMENT-REQUIRED` (or `X-PAYMENT-REQUIRED`) base64 header decoded as JSON,
     or JSON body with `x402Version: 2` / `accepts[]`.
   - **v1:** `X-PAYMENT` header, or JSON body with `paymentRequirements` / `maxAmountRequired`.
3. Extract: network, asset, amount, payTo presence.
4. For `/.well-known/x402` manifests: record which fields are present.
5. Classify:
   - `VALID_402` — 402 + parseable challenge + complete payment requirements (network, asset, amount)
   - `DEGRADED` — 402 but requirements incomplete
   - `MALFORMED` — 402 but challenge unparseable
   - `UNREACHABLE` — network error or timeout
   - `NOT_X402` — reachable but no 402
   - `VALID_MANIFEST` — manifest endpoint returning parseable JSON (informational, not a 402)

## Rate limits and politeness

- Max **1 request per 2 seconds per host**.
- **10-second timeout** per request.
- Identifiable User-Agent on every request.
- Single GET per target per scan. No retries hammering, no concurrency against one host.

## What we do NOT do

- Never submit payments or economic transactions.
- Never send credentials, API keys, or auth headers.
- Never attack, stress-test, or fuzz endpoints.
- Never bypass authentication or access controls.
- Never probe endpoints that require auth or are not publicly documented as demos.
- Never log full wallet addresses (truncated to first 8 chars in code paths; dashboard shows symbols), transaction hashes, or any PII.
- Never make security-certification claims. Diagnostic pages are operational
  reachability checks only, labeled as such.

## Target selection

Endpoints are added **only** when publicly documented as demos:

| Endpoint | Documented at |
|---|---|
| `payload-rail.fly.dev/v1/x402/public/evaluate` | Payload's own public API ([revrule-api.html](https://payloadhq.github.io/revrule-api.html)) |
| `payload-rail.fly.dev/.well-known/x402` | Payload's own x402 manifest |
| `liquidpad.site/api/x402/verify/…` | [liquidpad-x402-examples README](https://github.com/liquidpadbot/liquidpad-x402-examples) ("curl -i … Returns HTTP/2 402") |
| `kristo-intelligence-api.onrender.com/api/stats` | [autonomous-agent-x402-usdc-example README](https://github.com/hristovdimitri2-hub/autonomous-agent-x402-usdc-example) (documents 402 contract) |

We do not probe Coinbase production APIs, facilitator internals, or any endpoint
not explicitly published as a public demo.

## Outputs

- `data/observations-YYYY-MM-DD.json` — raw per-endpoint observations.
- `api/summary.json` — aggregate counts (machine-readable).
- `dashboard/index.html` — public dashboard.
- `dashboard/check/<slug>.html` — per-endpoint diagnostics.

## Reproducing

```bash
cd scanner
node scan.js            # writes data/observations-<today>.json + api/summary.json
node build-dashboard.js # writes dashboard/
```

## Limitations

- A single GET cannot verify payment settlement or facilitator behavior.
- "VALID_402" means the challenge is well-formed, not that paying succeeds.
- Listings change; an endpoint that was a public demo may be retired — targets are
  re-verified against their documented sources before each scan expansion.
