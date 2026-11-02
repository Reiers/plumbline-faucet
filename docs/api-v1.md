# Plumbline builder API v1

Stable, versioned JSON API for the Plumbline Filecoin Calibration faucet. Read endpoints need no auth. Use it from scripts, CI and dashboards instead of scraping pages.

## Overview

- Base URL: `https://faucet.reiers.io/api/v1`
- OpenAPI 3.1: [`/api/v1/openapi.json`](https://faucet.reiers.io/api/v1/openapi.json)
- Auth: none for reads. Drips need a Turnstile token or an API key, exactly like the unversioned drip routes.
- CORS: `Access-Control-Allow-Origin: *` on every v1 response.
- Every JSON body has `"apiVersion": "1"` (the OpenAPI document carries `x-apiVersion` instead, so it stays a valid OpenAPI object). Every response also has the header `X-API-Version: 1`.

## Endpoint reference

| Method | Path | Auth | Rate limit | Returns |
|--------|------|------|------------|---------|
| GET  | `/api/v1` | none | read budget | endpoint index |
| GET  | `/api/v1/faucet/status` | none | read budget | `healthy`, `state`, `reasons`, `dispenser`, per-asset balance, reserve floor, drip amounts, `limits`, `auth`, `stats` |
| GET  | `/api/v1/faucet/drips` | none | read budget | `drips[]` with `time`, `asset`, `amount`, `tx`, `explorerUrl`; `limit` (1-50, default 20), `offset`, `total`, `nextOffset` |
| GET  | `/api/v1/network` | none | read budget | `healthy`, `state`, Calix `level`, `chain`, `upgrade`, `signals`, `source`, `fetchedAt`, `stale` |
| GET  | `/api/v1/sp` | none | read budget | `healthy`, `state`, `targets[]` (t0143103), `source`, `fetchedAt`, `stale` |
| GET  | `/api/v1/openapi.json` | none | read budget | OpenAPI 3.1 document |
| POST | `/api/v1/drip/fil` | Turnstile token or API key | drip windows | `txHash`, `amount`, `asset`, `verified` |
| POST | `/api/v1/drip/usdfc` | Turnstile token or API key | drip windows | same, 0x or t410f recipients only |

The machine-readable version of this table is [`/api/v1/openapi.json`](https://faucet.reiers.io/api/v1/openapi.json).

## Stability promise

v1 is a contract. Build on it without pinning to a commit.

- **Additive only within v1.** We may add endpoints, response fields, error codes, query parameters and enum values. We do not remove or rename a field, change its type, or change what it means. Clients must ignore fields they do not know, and should treat unknown `error` codes and unknown `state` values as failures.
- **Breaking changes only in /api/v2.** Anything that would break a v1 client ships under a new prefix. v1 keeps running next to it.
- **At least 90 days notice before anything is retired.** Before an endpoint or a whole version is turned off:
  1. it is marked deprecated in this document, in `CHANGELOG.md` and in `/api/v1/openapi.json` (`deprecated: true`);
  2. its responses carry a `Deprecation` header (RFC 9745, the date it was deprecated) and a `Sunset` header (RFC 8594, the date it stops working), plus a `Link` header with `rel="deprecation"` pointing at the migration notes;
  3. the `Sunset` date is at least 90 days after the `Deprecation` date.
- **What is not covered.** The numeric values of drip amounts, reserve floors and rate limits are operational settings. They can change without notice and are always published live in `/api/v1/faucet/status`. Read them from there instead of hard coding them. Human-readable `message` and `headline` texts can change at any time.
- **Nothing is deprecated today.** The unversioned endpoints in [`api.md`](api.md) keep working, but new integrations should use v1.

Changes are listed in [`CHANGELOG.md`](../CHANGELOG.md).

## Rate limits

- Read endpoints: 60 requests per minute per IP. Every GET response carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds) and `RateLimit-Policy` (`60;w=60`). Over the limit you get HTTP 429 with `Retry-After` and the error envelope below.
- The service-wide burst limiter (300 requests per minute per IP) also applies to every route. It reports through `X-RateLimit-*` headers.
- Drip aliases share the exact handler, captcha check, API-key auth and per-IP, per-address and per-key windows of the unversioned drip routes. A drip through `/api/v1/drip/fil` counts against the same windows as one through `/api/drip/fil`. The current values are published in `limits` on `/api/v1/faucet/status`.

## Errors

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
| 400 | `invalid_address` | drip address could not be parsed |
| 400 | `unspendable_address` | drip address can never spend funds (see below) |
| 400 | `usdfc_native_unsupported` | USDFC requested for a t0/t1/t3 address |
| 400 | `captcha` | no API key, and the Turnstile token is missing or invalid |
| 401 | `invalid_api_key`, `revoked_api_key` | API key not recognised or disabled |
| 429 | `ip_rate_limited`, `address_rate_limited`, `api_key_rate_limited` | drip window exhausted; body has `retryAfterSec` and `retryAtUnix` |
| 503 | `faucet_dry` | dispenser below reserve floor |
| 500 | `drip_failed` | RPC error while sending the transaction |
| 404 | `not_found` | unknown path under `/api/v1` |
| 429 | `rate_limited` | read budget or service burst limit exhausted |
| 502 | `upstream_unavailable` | Calix did not answer and no usable cached value exists |
| 500 | `internal_error` | unexpected server error |

Drip aliases return the same codes as the unversioned drip routes, wrapped in the envelope.

### Unspendable addresses

Every drip path, including the unversioned ones and `/api/claim_token_all`, refuses recipients where nobody can ever spend the funds. The check runs before captcha and rate limits, so a refused request costs no quota. `reason` says which rule matched:

| reason | Addresses |
|--------|-----------|
| `zero_address` | `0x0000000000000000000000000000000000000000`, also as `t410f`/`f410f` |
| `evm_precompile` | `0x0000000000000000000000000000000000000001` to `...00ff` |
| `fevm_precompile` | `0xfe00000000000000000000000000000000000000` to `...00ff` |
| `masked_id_address` | `0xff0000000000000000000000` followed by an actor ID; send the wallet's own 0x or t410f address instead |
| `burn_address` | `0x000000000000000000000000000000000000dEaD` |
| `builtin_actor` | `t00` to `t099` (and `f0` forms): system, init, reward, cron, power, market, verified registry, datacap, EAM, burnt funds |

```json
{
  "apiVersion": "1",
  "ok": false,
  "error": "unspendable_address",
  "reason": "zero_address",
  "message": "The zero address cannot spend funds. Send your own wallet address."
}
```

## Caching and upstream failures

`/api/v1/network` and `/api/v1/sp` read Calix server side and cache the result for 30 seconds, so clients never need to call Calix directly. Each response says where the data came from and how old it is:

- `source`: `{ name, url, endpoints, generatedAt }`
- `fetchedAt` (ISO 8601), `cacheAgeSec`
- `stale`: `true` when Calix is failing and the last good value is being served, with `upstreamError` explaining why. Stale data is served for up to 10 minutes. After that the endpoint returns 502 `upstream_unavailable`.

`/api/v1/faucet/status` caches dispenser balances for 15 seconds. If the Calibration RPC is unreachable it still answers 200, with `rpcOk: false`, `healthy: false` and null balances, so limits and amounts stay readable.

Every status endpoint has `healthy` (boolean) and `state` (`ok`, `watch` or `bad`) for a simple traffic light.

## `GET /api/v1/faucet/status`

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

## `GET /api/v1/faucet/drips`

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

## `GET /api/v1/network`

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

## `GET /api/v1/sp`

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

## `POST /api/v1/drip/fil` and `POST /api/v1/drip/usdfc`

Stable aliases of the drip routes documented in [`api.md`](api.md). Same body (`address`, optional `turnstileToken`), same headers, same limits, same response fields plus `apiVersion` and, on errors, `message`.

```bash
curl -X POST https://faucet.reiers.io/api/v1/drip/fil   -H "Content-Type: application/json"   -H "X-API-Key: $PLUMBLINE_API_KEY"   -d '{"address": "0xYourAddressHere"}'
```

## Example: wait until the faucet can serve you

```js
const base = 'https://faucet.reiers.io/api/v1'
const s = await (await fetch(base + '/faucet/status')).json()
if (!s.assets.fil.canDrip) throw new Error('faucet below reserve: ' + s.reasons.join(','))
const n = await (await fetch(base + '/network')).json()
if (!n.healthy) console.warn('calibration is ' + n.state + ': ' + n.headline)
```

## Example: curl and jq

```bash
curl -s https://faucet.reiers.io/api/v1/faucet/status | jq -r '.assets.fil.canDrip'
curl -s 'https://faucet.reiers.io/api/v1/faucet/drips?limit=3' | jq -r '.drips[] | "\(.time) \(.asset) \(.amount) \(.explorerUrl)"'
curl -sI https://faucet.reiers.io/api/v1 | grep -i ratelimit
```

## Command-line client

`scripts/plumbline-cli` in this repo is a small client (bash, curl, jq):

```bash
scripts/plumbline-cli status          # faucet health, balances, limits
scripts/plumbline-cli network         # calibration health from Calix
scripts/plumbline-cli sp              # SP test-target status
scripts/plumbline-cli drips --limit 5 # recent drips
scripts/plumbline-cli status --json   # raw v1 JSON
PLUMBLINE_API=http://127.0.0.1:8003/api/v1 scripts/plumbline-cli status
```

`status`, `network` and `sp` exit 0 when `healthy` is true, 2 when it is false, and 1 on a request or API error, so they can gate a CI job:

```bash
scripts/plumbline-cli network >/dev/null || { echo "calibration not healthy, skipping e2e"; exit 0; }
```

## Known consumers

- The Plumbline status page ([status.reiers.io](https://status.reiers.io), source in [Reiers/plumbline-monitor](https://github.com/Reiers/plumbline-monitor)) renders its live signals from `/api/v1/faucet/status`, `/api/v1/network` and `/api/v1/sp`.
- `scripts/plumbline-cli` (this repo).
