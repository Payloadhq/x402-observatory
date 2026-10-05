# Payload X402 Observatory — Methodology

**Version:** 2.0 · **First scan:** 2026-10-05 · **Scale-up:** 2026-10-05
**Pipeline:** `scanner/ingest-bazaar.js` → `scanner/validate.js` → `scanner/build-dashboard.js` (zero-dependency Node.js)
**UA:** `Payload-X402-Observatory (+https://payloadhq.github.io/)`

## What this is

A public, continuously updated measurement of the operational health of publicly
discoverable x402 resources. Every number on the dashboard comes from an actual
catalog pull or probe. No estimates, no demo metrics, no invented data.

## Three different numbers — never conflated

- **DISCOVERED** — the resource appears in a public, unauthenticated x402 catalog.
  A listing is *not* evidence the resource works.
- **VALIDATED** — the Observatory probed the resource at least once with a
  non-paying HTTP GET.
- **ACTIVE** — the resource's most recent probe returned a well-formed 402 challenge.

Every aggregate on the dashboard and in the APIs displays the N it is computed over.

## Discovery (ingestion)

We consume only public, unauthenticated catalog endpoints — no API keys, no accounts:

| Source | Endpoint | Pagination |
|---|---|---|
| CDP x402 Bazaar | `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | `limit` / `offset` (page size 200) |
| PayAI Bazaar | `https://facilitator.payai.network/discovery/resources` | `limit` / `offset` (page size 200) |

- Max **1 request per 2 seconds per host**, 30s timeout, identifiable User-Agent.
- Collected per resource: resource URL, service name (host), type, x402 version,
  payment scheme, network, asset, amount, payTo (**truncated to first 10 chars + "…"**),
  source catalog, extensions present (bool), lastUpdated, tags, description (≤240 chars).
- We do **not** scrape private systems, directories behind logins, or facilitator internals.

### Normalization and dedupe

- Canonical key = `normalized-url | network | scheme`. Normalization: lowercase host,
  strip default ports, strip trailing slashes, drop query strings and fragments.
- Networks normalized to CAIP-style ids where catalogs differ
  (e.g. PayAI `base` → `eip155:8453`, `solana` → `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`).
- Duplicates across facilitators are merged (sources listed per resource).
- Junk filtered: localhost, loopback, `.local`/`.internal`, `0.0.0.0`, `example.*`,
  non-HTTP(S) schemes, malformed URLs, entries with no usable payment option.
- Registry state per resource: FIRST_SEEN, LAST_SEEN, LAST_VALIDATED, SOURCE,
  STATUS ∈ `DISCOVERED | ACTIVE | DEGRADED | UNREACHABLE | STALE`.
- Resources absent from a fresh catalog pull are marked **STALE**, never silently deleted.

## Validation

- At most **one non-paying HTTP GET per resource per day** (10s timeout,
  identifiable User-Agent, ≤1 request per 2 seconds per host).
- Queue priority: never-validated first (oldest first-seen), then entries not
  validated in the last 24h (recently-updated catalogs first). Entries failing
  UNREACHABLE three times consecutively are checked at most weekly.
- Inspect one live response:
  - **v2:** `PAYMENT-REQUIRED` base64 header, or JSON body with `x402Version: 2` / `accepts[]`.
  - **v1:** `X-PAYMENT` header, or JSON body with `paymentRequirements` / `maxAmountRequired`.
- **Verdicts:**
  - `VALID_402` — 402 + parseable challenge + complete requirements (network, asset, amount)
  - `DEGRADED` — 402 but requirements incomplete or challenge unparseable
  - `MALFORMED` — (rolled into DEGRADED in aggregates)
  - `UNREACHABLE` — DNS/TCP/TLS/timeout error
  - `NOT_X402` — reachable but no 402 (treated as DEGRADED for status purposes)
- Response latency recorded per probe; dashboard shows median and p95 over the
  validated set.
- Metadata consistency: live challenge network/scheme compared against catalog entry.

## Metrics

All rates are computed over the **validated** set unless labeled otherwise:

- `VALID_402_RATE` = VALID_402 / validated
- `DEGRADED_RATE` = (DEGRADED + MALFORMED) / validated
- `UNREACHABLE_RATE` = UNREACHABLE / validated
- `STALE_RATE` = STALE / discovered
- Distributions: V1 vs V2, network share, asset share, payment-scheme share,
  price buckets (from atomic amounts with known asset decimals; unknown amounts → "unknown";
  public output uses **buckets only, never exact amounts**)
- `TOP_FAILURE_MODES` from latest verdict details
- `MEDIAN` / `P95` response ms
- `NEW_THIS_WEEK` (firstSeen ≤ 7 days), `GONE_THIS_WEEK` (marked STALE ≤ 7 days)

### Ecosystem health (observable metrics only — never a security score)

Health = valid-402 rate over validated resources:

| Status | Rule |
|---|---|
| HEALTHY | valid-402 rate ≥ 90% |
| MIXED | valid-402 rate 70–90% |
| DEGRADED | valid-402 rate < 70% |
| INSUFFICIENT_DATA | fewer than 25 resources validated |

This is an operational diagnostic. It says nothing about the security, safety, or
trustworthiness of any listed service.

## Historical trending

Daily snapshots at `data/snapshots/YYYY-MM-DD.json` record discovered count,
validated count, rates, version/network splits, and latency. The dashboard renders
7-day, 30-day, and all-time windows from whatever snapshots exist (even one).

## Outputs

- `data/registry.json` — durable registry (all states, history per resource)
- `data/discovered-YYYY-MM-DD.json` — per-pull ingest summary
- `data/validated-YYYY-MM-DD.json` — per-run validation results
- `data/snapshots/YYYY-MM-DD.json` — daily aggregate snapshot
- `api/summary.json` — headline metrics (machine-readable)
- `api/resources.json` — top 500 resources with status + history (capped)
- `api/networks.json`, `api/failures.json`, `api/history.json`
- `dashboard/index.html` — public dashboard
- `dashboard/check/<slug>.html` — v1 per-endpoint diagnostics (retained)

All APIs are free and public. Corrections/removals: kyler.simmons.partners@gmail.com.
Listing implies no endorsement or ownership.

## What we do NOT do

- Never submit payments or economic transactions.
- Never send credentials, API keys, or auth headers.
- Never attack, stress-test, fuzz, or bypass authentication.
- Never log full wallet addresses, transaction hashes, or any PII.
- Never make security-certification claims.
- Never imply a resource works because it is listed in a catalog.

## Legacy (v1, 2026-10-05)

The original 4-endpoint probe (`scanner/scan.js`, `targets.json`) scanned only
publicly documented demo endpoints (Payload's own, LiquidPad, Kristo) — it never
probed undocumented commercial endpoints, and neither does v2. The v1 builder is
kept as `scanner/build-dashboard-v1.js`; its diagnostic pages remain under
`dashboard/check/`.

## Reproducing

```bash
cd scanner
node ingest-bazaar.js   # pulls both catalogs → data/registry.json
node validate.js        # probes queued resources (default max 300/run)
node build-dashboard.js # writes dashboard/ + api/*.json + snapshot
```

## Limitations

- A single GET cannot verify payment settlement or facilitator behavior.
- "VALID_402" means the challenge is well-formed, not that paying succeeds.
- Catalogs are auto-indexed from settled payments; listings include stale,
  test, and abandoned endpoints — validation exists precisely to separate signal from listing.
- Validation covers a growing subset of discovered resources; rates are reported
  over the validated N, never extrapolated to the whole catalog.
