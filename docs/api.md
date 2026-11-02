# Plumbline Faucet API

Programmatic interface to the Filecoin Calibration faucet at `https://faucet.reiers.io`. Intended for CLI tooling, integration tests, and CI pipelines that need tFIL or USDFC on calibration without solving a captcha.

All endpoints return JSON. CORS is open.

---

## Builder API v1 (stable)

Use these endpoints for new integrations. They are versioned, documented in an OpenAPI 3.1 file, and read-only apart from the two drip aliases. No scraping needed.

- Base URL: `https://faucet.reiers.io/api/v1`
- OpenAPI 3.1: [`/api/v1/openapi.json`](https://faucet.reiers.io/api/v1/openapi.json)
- Auth: none for reads. Drips need a Turnstile token or an API key, same as before.
- CORS: `Access-Control-Allow-Origin: *` on every v1 response.
- Every JSON body has `"apiVersion": "1"` (the OpenAPI document carries `x-apiVersion` instead, so it stays a valid OpenAPI object). Every response also has the header `X-API-Version: 1`.

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/v1` | index of endpoints |
| GET  | `/api/v1/faucet/status` | healthy flag, dispenser address, balances, reserve floors, drip amounts, public limits |
| GET  | `/api/v1/faucet/drips` | recent drips with amount, tx hash and explorer link (`limit` 1-50, `offset`) |
| GET  | `/api/v1/network` | Calibration health from Calix `/api/v1/status` + `/api/v1/signals` |
| GET  | `/api/v1/sp` | SP test-target status (`t0143103`) from Calix |
| GET  | `/api/v1/openapi.json` | OpenAPI 3.1 description |
| POST | `/api/v1/drip/fil` | alias of `POST /api/drip/fil` |
| POST | `/api/v1/drip/usdfc` | alias of `POST /api/drip/usdfc` |

### Stability

Within v1, fields are only added. Existing fields are never removed or renamed and keep their meaning. A breaking change ships as `/api/v2`, and v1 keeps running alongside it. Clients should ignore fields they do not know.

### Rate limits

- Read endpoints: 60 requests per minute per IP. Every GET response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds) and `RateLimit-Policy` (`60;w=60`). Over the limit you get HTTP 429 with `Retry-After` and the error envelope below.
- The service-wide burst limiter (300 requests per minute per IP) also applies to every route. It reports through `X-RateLimit-*` headers.
- Drip aliases share the exact handler, captcha check, API-key auth and per-IP, per-address and per-key windows of the unversioned drip routes. A drip through `/api/v1/drip/fil` counts against the same windows as one through `/api/drip/fil`. The current values are published in `limits` on `/api/v1/faucet/status`.

### Errors

Every v1 error uses one envelope:

```json
{
  "apiVersion": "1",
  "ok": false,
  "error": "rate_limited",
  "message": "Too many requests. Retry after 42s.",
  "retryAfterSec": 42
}
```

`error` is a stable machine-readable code. `message` is for humans and may change. Extra fields can appear depending on the code (drip 429s keep `scope`, `used`, `max`, `windowSec`, `retryAfterSec`, `retryAtUnix`).

| HTTP | error | When |
|------|-------|------|
| 400 | `bad_request` | invalid query parameter or request body |
| 404 | `not_found` | unknown path under `/api/v1` |
| 429 | `rate_limited` | read budget or service burst limit exhausted |
| 502 | `upstream_unavailable` | Calix did not answer and no usable cached value exists |
| 500 | `internal_error` | unexpected server error |

Drip aliases return the same codes as the unversioned drip routes (see [Error responses](#error-responses)), wrapped in the envelope.

### Caching and upstream failures

`/api/v1/network` and `/api/v1/sp` read Calix server side and cache the result for 30 seconds, so clients never need to call Calix directly. Each response says where the data came from and how old it is:

- `source`: `{ name, url, endpoints, generatedAt }`
- `fetchedAt` (ISO 8601), `cacheAgeSec`
- `stale`: `true` when Calix is failing and the last good value is being served, with `upstreamError` explaining why. Stale data is served for up to 10 minutes. After that the endpoint returns 502 `upstream_unavailable`.

`/api/v1/faucet/status` caches dispenser balances for 15 seconds. If the Calibration RPC is unreachable it still answers 200, with `rpcOk: false`, `healthy: false` and null balances, so limits and amounts stay readable.

Every status endpoint has `healthy` (boolean) and `state` (`ok`, `watch` or `bad`) for a simple traffic light.

### `GET /api/v1/faucet/status`

```bash
curl -s https://faucet.reiers.io/api/v1/faucet/status | jq '{healthy, state, reasons, fil: .assets.fil}'
```

```json
{
  "apiVersion": "1",
  "ok": true,
  "network": "calibration",
  "chainId": 314159,
  "healthy": true,
  "state": "ok",
  "reasons": [],
  "rpcOk": true,
  "dispenser": "0x1aB747560deFa40D27627AA507c6bd3680c28c6B",
  "assets": {
    "fil": {
      "symbol": "tFIL", "decimals": 18,
      "balance": "1441785.99", "balanceWei": "1441785990000000000000000",
      "reserveFloor": "50000", "reserveFloorWei": "50000000000000000000000",
      "dripAmount": "5000", "publicDripAmount": "1000", "canDrip": true
    },
    "usdfc": {
      "symbol": "USDFC", "decimals": 18, "contract": "0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0",
      "balance": "42185", "balanceWei": "42185000000000000000000",
      "reserveFloor": "20000", "reserveFloorWei": "20000000000000000000000",
      "dripAmount": "2000", "publicDripAmount": "100", "canDrip": true
    }
  },
  "limits": {
    "captcha": { "perIp": { "max": 2, "windowSec": 86400 }, "perAddress": { "max": 2, "windowSec": 86400 } },
    "apiKey":  { "perKey": "set per key by the operator", "perAddress": { "max": 2, "windowSec": 86400 } },
    "public":  { "perIp": { "max": 1, "windowSec": 86400 }, "perAddress": { "max": 2, "windowSec": 86400 } },
    "requestsPerIpPerMinute": 300,
    "readRequestsPerIpPerMinute": 60
  },
  "auth": { "captcha": "turnstile", "turnstileSiteKey": "0x...", "apiKeySupported": true },
  "drip": { "fil": "/api/v1/drip/fil", "usdfc": "/api/v1/drip/usdfc", "publicFil": "/api/public/drip/fil", "publicUsdfc": "/api/public/drip/usdfc" },
  "stats": { "totalDrips": { "fil": 1234, "usdfc": 567 }, "distributedWei": { "fil": "...", "usdfc": "..." }, "drips24h": { "fil": 3, "usdfc": 1 } },
  "fetchedAt": "2026-11-02T11:35:57.523Z",
  "cacheAgeSec": 4,
  "stale": false
}
```

`canDrip` is false when the balance is below reserve floor plus one drip, the same rule the drip handler uses before it refuses with `faucet_dry`. `reasons` lists why `healthy` is false: `rpc_unreachable`, `fil_below_reserve`, `usdfc_below_reserve`.

### `GET /api/v1/faucet/drips`

```bash
curl -s "https://faucet.reiers.io/api/v1/faucet/drips?limit=2"
```

```json
{
  "apiVersion": "1",
  "ok": true,
  "network": "calibration",
  "limit": 2,
  "offset": 0,
  "total": 50,
  "nextOffset": 2,
  "retention": 50,
  "drips": [
    {
      "time": "2026-11-02T10:12:03.000Z",
      "unix": 1793614323,
      "asset": "fil",
      "amount": "1000",
      "amountWei": "1000000000000000000000",
      "address": "0x...",
      "tx": "0x...",
      "explorerUrl": "https://calibration.filfox.info/en/message/0x..."
    }
  ]
}
```

The server keeps the last 50 drips. Page with `offset=nextOffset` until `nextOffset` is null. `amount` is null for drips recorded before per-drip amounts were stored.

### `GET /api/v1/network`

```bash
curl -s https://faucet.reiers.io/api/v1/network | jq '{healthy, state, level, chain, stale, fetchedAt}'
```

```json
{
  "apiVersion": "1",
  "ok": true,
  "network": "calibration",
  "healthy": true,
  "state": "ok",
  "level": "operational",
  "headline": "All systems operational",
  "detail": "Calibration nv29 producing blocks normally",
  "forked": false,
  "chain": { "epoch": 4209765, "networkVersion": 29, "headAgeSeconds": 27 },
  "upgrade": { "name": "Solstice", "epoch": 4109133, "unix": 1790600370, "secondsLeft": -3018987, "activated": true },
  "signals": {
    "windowEpochs": 60,
    "blocksPerEpoch": { "value": 3.12, "unit": "blocks", "status": "ok" },
    "nullRoundPercent": { "value": 0, "unit": "%", "status": "ok" },
    "baseFee": { "value": 101.08, "unit": "atto", "status": "ok" },
    "winCountAvg": { "value": 6.12, "unit": "wins", "status": "ok" },
    "networkQAP": { "value": 1065.75, "unit": "TiB", "status": "ok" },
    "activeMiners": { "value": 8, "unit": "miners", "status": "watch" },
    "totalPledge": { "value": 3725704.35, "unit": "FIL", "status": "ok" },
    "ipPerSector32GiB": { "value": 38.59, "unit": "FIL/32GiB", "status": "ok" }
  },
  "source": { "name": "calix", "url": "https://calix.reiers.io", "endpoints": ["/api/v1/status", "/api/v1/signals"], "generatedAt": 1793619357 },
  "fetchedAt": "2026-11-02T11:35:57.639Z",
  "cacheAgeSec": 0,
  "stale": false
}
```

`state` is `bad` when Calix reports `degraded` or a fork, `watch` for the `watch` or `upgrade` levels or a head older than 5 minutes, otherwise `ok`. `level` is the raw Calix value.

### `GET /api/v1/sp`

```json
{
  "apiVersion": "1",
  "ok": true,
  "network": "calibration",
  "healthy": true,
  "state": "ok",
  "epoch": 4209765,
  "windowEpochs": 60,
  "targets": [
    { "address": "t0143103", "status": "ok", "state": "ok", "healthy": true, "blocksLast60": 52, "lastBlockEpoch": 4209765, "lastBlockAgeSec": 27 }
  ],
  "source": { "name": "calix", "url": "https://calix.reiers.io", "endpoints": ["/api/v1/miners/status?addrs=t0143103"], "generatedAt": 1793619357 },
  "fetchedAt": "2026-11-02T11:35:57.767Z",
  "cacheAgeSec": 0,
  "stale": false
}
```

### `POST /api/v1/drip/fil` and `POST /api/v1/drip/usdfc`

Stable aliases of the drip routes documented below. Same body (`address`, optional `turnstileToken`), same headers, same limits, same response fields plus `apiVersion` and, on errors, `message`.

```bash
curl -X POST https://faucet.reiers.io/api/v1/drip/fil   -H "Content-Type: application/json"   -H "X-API-Key: $PLUMBLINE_API_KEY"   -d '{"address": "0xYourAddressHere"}'
```

### Example: wait until the faucet can serve you

```js
const base = 'https://faucet.reiers.io/api/v1'
const s = await (await fetch(base + '/faucet/status')).json()
if (!s.assets.fil.canDrip) throw new Error('faucet below reserve: ' + s.reasons.join(','))
const n = await (await fetch(base + '/network')).json()
if (!n.healthy) console.warn('calibration is ' + n.state + ': ' + n.headline)
```

Known consumer: the Plumbline status page ([status.reiers.io](https://status.reiers.io), source in [Reiers/plumbline-monitor](https://github.com/Reiers/plumbline-monitor)) renders its live signals from `/api/v1/faucet/status`, `/api/v1/network` and `/api/v1/sp`.

---

## Unversioned endpoints

These predate v1 and keep working unchanged. New integrations should prefer v1.

## Quick reference

| Method | Path                | Purpose                                     | Auth |
|--------|---------------------|---------------------------------------------|------|
| GET    | `/healthz`          | liveness + dispenser balances               | none |
| GET    | `/api/info`         | brand, drip amounts, rate-limit defaults    | none |
| GET    | `/api/stats`        | lifetime + 24h counters                     | none |
| GET    | `/api/recent`       | last N drips (address + tx hashes)          | none |
| GET    | `/api/convert`      | 0x ↔ f410f address conversion               | none |
| POST   | `/api/drip/fil`     | request a tFIL drip                         | captcha OR API key |
| POST   | `/api/drip/usdfc`   | request a USDFC drip (0x / t410f only)      | captcha OR API key |

---

## Authentication for drip endpoints

The drip endpoints accept **either**:

1. **Cloudflare Turnstile token** (the default, used by the browser UI). Pass `{ "turnstileToken": "..." }` in the JSON body. Not usable from CLI.

2. **API key** (intended for CLI / CI). Pass it as an HTTP header:

   ```
   Authorization: Bearer <key>
   ```

   or:

   ```
   X-API-Key: <key>
   ```

   A request that presents a valid, enabled key bypasses the captcha entirely.

### Getting an API key

API keys are issued out-of-band by the operator. To request one, email `nicklas@reiers.io` (or DM `@Reiers` on Filecoin Slack) with:

- Your name / project name
- A short description of what you'll use it for (test runner, CI, CLI, etc)
- Expected drip volume (per day)

Default per-key allowance is 50 drips per asset per 24 hours, which is plenty for normal CI usage. Higher limits are available on request.

### Rate limits with an API key

When using an API key, the per-IP limit is **replaced** by a per-key window. Per-address limits still apply (so you cannot drain the faucet into a single wallet by rotating keys). Default per-address limit is 2 drips per asset per 24 hours.

| Limit            | With API key             | Without API key (captcha) |
|------------------|--------------------------|---------------------------|
| Per IP           | not enforced             | 2 / asset / 24h           |
| Per address      | 2 / asset / 24h          | 2 / asset / 24h           |
| Per API key      | configurable per key     | n/a                       |

---

## Endpoints

### `GET /api/info`

Public metadata about the faucet. Useful for clients to discover drip amounts and rate-limit defaults.

```bash
curl https://faucet.reiers.io/api/info
```

```json
{
  "brand": "Plumbline",
  "filDrip": "5",
  "usdfcDrip": "100",
  "ipRateLimitSec": 86400,
  "addressRateLimitSec": 86400,
  "maxDripsPerIp": 2,
  "maxDripsPerAddress": 2,
  "turnstileSiteKey": "0x...",
  "usdfcAddress": "0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0",
  "rpcUrl": "https://api.calibration.node.glif.io/rpc/v1",
  "dispenser": "0x...",
  "filBalanceWei": "...",
  "usdfcBalanceWei": "...",
  "minReserveFil": "20",
  "minReserveUsdfc": "500",
  "apiKeyAuthSupported": true
}
```

### `POST /api/drip/fil`

Request a tFIL drip.

**Body:**
- `address` (required), any of:
  - `0x...` Ethereum-style address (40 hex)
  - `t410f...` delegated Filecoin address (gets converted to the matching 0x)
  - `t1...`, `t3...` native Filecoin BLS/SECP address
  - `t0...` ID address
- `turnstileToken` (optional, ignored if API key present): Turnstile token from the browser UI

**Headers (for CLI):**
- `Authorization: Bearer <key>` **or** `X-API-Key: <key>`

**Example (CLI with API key):**

```bash
curl -X POST https://faucet.reiers.io/api/drip/fil \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_yourkeyhere" \
  -d '{"address": "0xYourAddressHere"}'
```

**Success response (200):**

```json
{
  "ok": true,
  "txHash": "0xabc...",
  "verified": true,
  "amount": "5000000000000000000",
  "asset": "fil"
}
```

### `POST /api/drip/usdfc`

Same as `/api/drip/fil` but for the USDFC ERC-20. Only accepts `0x` or `t410f` addresses (USDFC is an ERC-20 token; native t1/t3 addresses don't hold ERC-20 balances directly).

```bash
curl -X POST https://faucet.reiers.io/api/drip/usdfc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_yourkeyhere" \
  -d '{"address": "0xYourAddressHere"}'
```

### `GET /api/convert`

Convert between `0x` and `f410f` form using the underlying lotus RPC.

```bash
curl "https://faucet.reiers.io/api/convert?address=0xabc..."
```

```json
{ "ok": true, "input": "0xabc...", "output": "f410f..." }
```

### `GET /api/stats`

```bash
curl https://faucet.reiers.io/api/stats
```

```json
{
  "totalDrips": { "fil": 1234, "usdfc": 567 },
  "totalDistributed": { "fil": "6170", "usdfc": "56700" },
  "drips24h": { "fil": 42, "usdfc": 13 }
}
```

### `GET /api/recent?limit=10`

Last N drips (max 50). Returns address + tx hash + timestamp.

```bash
curl "https://faucet.reiers.io/api/recent?limit=5"
```

---

## Error responses

All errors are JSON with `ok: false` and an `error` code. HTTP status reflects the error class.

| HTTP | error                       | When                                                        |
|------|-----------------------------|-------------------------------------------------------------|
| 400  | `bad_request`               | body didn't parse                                           |
| 400  | `invalid_address`           | address couldn't be classified                              |
| 400  | `unspendable_address`       | zero address, precompile, masked ID (0xff00...), burn address or built-in actor (t00 to t099); `reason` says which |
| 400  | `usdfc_native_unsupported`  | tried to drip USDFC to a native t1/t3 address               |
| 400  | `captcha`                   | no API key, and Turnstile token was missing or invalid      |
| 401  | `invalid_api_key`           | API key header present but not recognised                   |
| 401  | `revoked_api_key`           | API key was disabled by the operator                        |
| 429  | `api_key_rate_limited`      | per-key drip window exhausted                               |
| 429  | `ip_rate_limited`           | per-IP window exhausted (no API key)                        |
| 429  | `address_rate_limited`      | per-address window exhausted                                |
| 503  | `faucet_dry`                | dispenser balance below the configured reserve              |
| 500  | `drip_failed`               | RPC error sending the on-chain tx                           |

A 429 always includes:

```json
{
  "scope": "ip" | "address" | "api_key",
  "used": 2,
  "max": 2,
  "windowSec": 86400,
  "retryAfterSec": 12345,
  "retryAtUnix": 1700000000
}
```

Use `retryAtUnix` (epoch seconds) to know when to retry; it's already adjusted for the actual window open time.

---

## Example: shell helper for CI

```bash
#!/usr/bin/env bash
set -euo pipefail

ADDR="${1:?usage: drip-fil <address>}"
KEY="${PLUMBLINE_API_KEY:?set PLUMBLINE_API_KEY in env}"

resp=$(curl -fsS -X POST https://faucet.reiers.io/api/drip/fil \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${KEY}" \
  -d "{\"address\": \"${ADDR}\"}")

echo "${resp}" | jq .
tx=$(echo "${resp}" | jq -r .txHash)
echo "Drip tx: ${tx}"
```

## Example: TypeScript

```ts
const resp = await fetch('https://faucet.reiers.io/api/drip/fil', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.PLUMBLINE_API_KEY}`,
  },
  body: JSON.stringify({ address: '0xYourAddressHere' }),
})
const data = await resp.json()
if (!data.ok) throw new Error(`drip failed: ${data.error} (${data.reason ?? ''})`)
console.log('tx:', data.txHash)
```

---

## Operator notes

To issue an API key (operator only):

```bash
pnpm run keygen create --name "Lee CLI test runner" \
  --max-drips 50 --window-sec 86400 --notes "lee@example.com"
```

List keys:

```bash
pnpm run keygen list
```

Revoke / re-enable:

```bash
pnpm run keygen revoke pk_xxxxx
pnpm run keygen enable pk_xxxxx
```

Inspect a key (including current window usage):

```bash
pnpm run keygen show pk_xxxxx
```
