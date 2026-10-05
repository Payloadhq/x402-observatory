# Payload X402 Observatory — Methodology

**Version:** 2.1 · **First scan:** 2026-10-05 · **Scale-up:** 2026-10-05
**Pipeline:** `scanner/ingest-bazaar.js` → `scanner/validate.js` → `scanner/accounting.js` → `scanner/build-dashboard.js` (zero-dependency Node.js)
**UA:** `Payload-X402-Observatory (+https://payloadhq.github.io/)`

## What this is

A public, continuously updated measurement of the operational health of publicly
discoverable x402 resources. Every number on the dashboard comes from an actual
catalog pull or probe. No estimates, no demo metrics, no invented data.

## Six different numbers — never conflated

- **DISCOVERED** — the resource appears in a public, unauthenticated x402 catalog.
  A listing is *not* evidence the resource works. DISCOVERED resources have not
  been operationally tested.
- **VALIDATED** — the Observatory probed the resource at least once with a
  method-aware, non-paying request.
- **ACTIVE** — the resource's most recent probe returned a well-formed 402 challenge.
- **DEGRADED** — reachable, but the 402 challenge is incomplete/missing, or the
  catalog listing is inconsistent with live behavior.
- **UNREACHABLE** — network error on last probe (DNS/TCP/TLS/timeout).
- **STALE** — no longer present in the source catalog.

Every aggregate on the dashboard and in the APIs displays the N it is computed over.

## Discovery (ingestion)

We consume only public, unauthenticated catalog endpoints — no API keys, no accounts:

| Source | Endpoint | Pagination |
|---|---|---|
| CDP x402 Bazaar | `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | `limit` / `offset` (page size 200) |
| PayAI Bazaar | `https://facilitator.payai.network/discovery/resources` | `limit` / `offset` (page size 200) |

- Max **1 request per 2 seconds per host**, 30s timeout, identifiable User-Agent.
- Collected per resource: resource URL, service name (host), type, **declared HTTP
  method** (`method` / `extensions.bazaar.info.input.method`, when present),
  x402 version, payment scheme, network, asset, amount, payTo
  (**truncated to first 10 chars + "…"**), source catalog, extensions present (bool),
  lastUpdated, tags, description (≤240 chars).
- We do **not** scrape private systems, directories behind logins, or facilitator internals.

### Count accounting (reproducible)

Catalog listings and resources are different units, and the dashboard never
mixes them:

- **LISTINGS DISCOVERED** = unique usable catalog records (raw API items minus junk).
- **RESOURCES DISCOVERED** = unique canonical payment options
  (`normalized-url | network | scheme`), expanded from each listing's `accepts[]`.
  One listing commonly exposes several payment options, so resources > listings.

Reproducible ledger (per source): catalog items seen → junk removed →
usable listings → expanded by accepts options → duplicates-in-pull removed →
unique keys; then cross-source duplicates removed → final unique resources.
`scanner/accounting.js` prints this ledger and writes `data/accounting.json`,
which the dashboard's accounting table renders verbatim. Every displayed number
traces to this ledger.

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

## Validation (methodology v2)

We do **not** assume GET. The probe method is, in order:

1. The HTTP method declared in Bazaar discovery metadata —
   top-level `method` (PayAI) or `extensions.bazaar.info.input.method` (CDP);
2. otherwise GET.

Rules:

- At most **one non-paying request per resource per revalidation window**
  (7 days; first probe prioritized), 10s timeout, identifiable User-Agent,
  **max 1 request per host per 5 minutes**, sequential probing (concurrency 1),
  no payments, no credentials, no auth headers, no stress testing.
- POST probes (only when the catalog or the server's `Allow` header declares POST)
  send an **empty JSON body** and stop at the first response — a well-behaved
  x402 server answers 402 before executing anything. No payment signature,
  no parameters, no side effects.
- Unsafe methods (DELETE, PUT, PATCH, …) are **never probed** → `NOT_APPLICABLE`.
- `type=mcp` resources are **never HTTP-probed** → `NOT_APPLICABLE` (they stay
  DISCOVERED: discovered-only, not operationally tested, excluded from rates).
- A GET returning **405 is not an endpoint failure.** If the server's `Allow`
  header or the catalog declares POST, one non-paying POST probe is made and the
  result stands. Otherwise the verdict is `METADATA_MISMATCH`: the catalog
  listing is inconsistent with live behavior — a discovery problem, not an
  endpoint failure. Failures are only classified when the appropriate documented
  method was used.
- **Verdicts → status:**
  - `VALID_402` → ACTIVE (402 + parseable challenge + complete network/asset/amount)
  - `DEGRADED` → DEGRADED, with failure mode:
    `INCOMPLETE_CHALLENGE` (402, requirements incomplete),
    `MALFORMED_CHALLENGE` (402, unparseable),
    `METADATA_MISMATCH` (method inconsistency),
    `ROUTE_NOT_FOUND` (404 — stale catalog listing),
    `CHALLENGE_MISSING` (200 without payment — x402 not enforced),
    `UNEXPECTED_STATUS`
  - `UNREACHABLE` → UNREACHABLE (DNS/TCP/TLS/timeout)
  - `NOT_APPLICABLE` → stays DISCOVERED (not operationally tested)
- Response latency recorded per probe; dashboard shows median and p95 over the
  validated set.
- Metadata consistency: live challenge network/scheme compared against catalog entry.

### Rotating validation (responsible scale)

The universe is ~71K resources; mass-probing is off the table. Validation grows via
a **daily stratified sample** (`node scanner/validate.js --batch 200 --seed YYYYMMDD`):

- Stratified across network × discovery source × x402 version × price bucket
  (seeded-shuffled, reproducible), never-validated first, then revalidation of
  entries older than 7 days (≤20% of a batch).
- **Max 1 probe per host per run** in addition to the 5-minute per-host minimum.
- Queue persists in `data/validation-queue.json` (resumable); a scheduled GitHub
  Action runs the batch daily and commits results (`.github/workflows/validate-daily.yml`).
- Rates are always reported over the validated N, never extrapolated.

### Opt-out

Operators can request exclusion of their hosts or correction/removal of a
listing: kyler.simmons.partners@gmail.com. Opted-out hosts are recorded in
`data/opt-out.json` and skipped by validation.

## Metrics

All rates are computed over the **applicable validated** set (MCP-type and
unsafe-method resources are not HTTP-probed and are excluded) unless labeled otherwise:

- `VALID_402_RATE` = VALID_402 / applicable validated
- `DEGRADED_RATE` = DEGRADED / applicable validated
- `UNREACHABLE_RATE` = UNREACHABLE / applicable validated
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
- `dashboard/observatory.js` — privacy-respecting usage beacon (aggregate counts only)
- `dashboard/check/<slug>.html` — v1 per-endpoint diagnostics (retained)

All APIs are free and public. Corrections/removals/opt-out: kyler.simmons.partners@gmail.com.
Listing implies no endorsement or ownership.

## Observatory usage analytics

A tiny client beacon (`dashboard/observatory.js`, `navigator.sendBeacon`) reports
aggregate-only events to `POST /v1/events/observatory` on the Payload rail:
`page_view`, `search_used`, `report_viewed`, `cta_click`, `checker_click`,
`github_action_click`, `product_click`, `checkout_click`. The request body may
contain only an allowlisted event name and CTA name; everything else is ignored.
The server stores **hourly counts only — no IPs, no user agents, no cookies, no
fingerprints, no identifiers**. CORS is restricted to the Observatory origin.
The beacon is a silent no-op if the endpoint is unreachable, so the dashboard
never depends on it.

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
node ingest-bazaar.js                  # pulls both catalogs → data/registry.json
node validate.js --batch 200 --seed YYYYMMDD  # stratified daily batch
node accounting.js                     # prints ledger → data/accounting.json
node build-dashboard.js                # writes dashboard/ + api/*.json + snapshot
```

## Limitations

- A single non-paying probe cannot verify payment settlement or facilitator behavior.
- "VALID_402" means the challenge is well-formed, not that paying succeeds.
- Catalogs are auto-indexed from settled payments; listings include stale,
  test, and abandoned endpoints — validation exists precisely to separate signal from listing.
- Validation covers a growing subset of discovered resources; rates are reported
  over the validated N, never extrapolated to the whole catalog.
- MCP-type resources are not HTTP-probed; their operational status is unknown to us.
