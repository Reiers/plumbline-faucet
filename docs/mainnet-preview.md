# Mainnet preview: USDFC + FIL for FoC integrators

Plumbline runs a small, capped faucet on **Filecoin mainnet** so teams
building on Filecoin Onchain Cloud (FoC) can test paid deal flows with
real mainnet USDFC and a little FIL for gas. It is the same dual-asset
dispenser as the Calibration faucet, run as a separate instance with
its own key, database and policy.

- Page: <https://faucet.reiers.io/mainnet/>
- JSON: <https://faucet.reiers.io/mainnet/api/info>, <https://faucet.reiers.io/mainnet/api/status>
- Prometheus: <https://faucet.reiers.io/mainnet/metrics>
- Operator runbook: [mainnet-activation-runbook.md](mainnet-activation-runbook.md)

**Status: mainnet preview, not yet activated.** The instance ships with
drips disabled; the operator loads the float and turns drips on at
activation (see [Funding model](#funding-model)). Amounts are small on
purpose. It is meant for
integration testing, not for funding production workloads.

## Funding model

The float is **loaded by the operator at activation**. Until then the
instance runs with drips disabled and is safe with any balance,
including zero.

- **Ships disabled.** The kill switch is on by default. Activation is
  one env flag (`MAINNET_KILL_SWITCH=0`) after the float is loaded.
  While disabled, the page, `api/info` and `api/status` show
  "Mainnet preview (not yet activated)".
- **Maximum monthly exposure** is the hard monthly cap: **100 USDFC +
  1 FIL per calendar month (UTC)**, about **101 USD** at about 1 USD
  per USDFC and 0.86 USD per FIL (2 November 2026). This bound holds
  whatever the float size. Gas is paid from the FIL float and is well
  under 0.001 FIL per month at current fees.
- **Reserve floor:** 10 USDFC and 0.5 FIL are never paid out. A drip is
  refused if it would take the float below the floor.
- **Float size:** one month of cap plus the floor (110 USDFC + 1.5 FIL)
  covers a full month at the cap. Keeping the float near that size
  also bounds the loss if the dispenser key were ever stolen (caps
  limit abuse through the API, not key theft).
- **Top up and withdraw:** the operator sends USDFC and FIL to the
  dispenser address in `GET api/info` (`dispenser`), and withdraws all
  or part of the float to a withdrawal address with the drain tool
  (pause, simulate, execute). See the [runbook](mainnet-activation-runbook.md).
- **Transparency:** `api/status` and `metrics` show `funded`, balance,
  floor, month-to-date outflow and cap for each asset. Every drip has a
  public transaction hash, and the instance keeps a full outflow
  ledger.

When drips cannot be paid, requests get a `503` with a `statusNote`:

- `mainnet_paused`: not yet activated, or paused by the operator,
- `preview_unfunded`: nothing above the reserve floor (includes a zero
  float), with `funded: false`, `balance`, `floor`,
- `faucet_dry`: less than one drip above the floor, or no FIL left for
  gas, same fields.

## Network and token

| | |
| --- | --- |
| Chain | Filecoin mainnet, chain id 314 |
| RPC (default) | `https://api.node.glif.io/rpc/v1` |
| USDFC | `0x80B98d3aa09ffff255c3ba4A241111Ff1262F045` (18 decimals) |
| Recipients | `0x...` or `f410f...` only |

The USDFC address comes from FilOzone's synapse-sdk
(`packages/synapse-core/src/chains.ts`, chain id 314,
`contracts.usdfc.address`). On chain it reports `symbol() = "USDFC"`,
`decimals() = 18` and `name() = "USD for Filecoin Community"`. The CI
binding tests check all three on every run.

Native `f0`/`f1`/`f2`/`f3` recipients are not supported in the preview.
Testnet `t...` addresses are rejected with `testnet_address`.

## Caps

All values are defaults; the operator can change them in config. The
live values are always in `GET /mainnet/api/info` under `policy`.

| Limit | USDFC | FIL | Window |
| --- | --- | --- | --- |
| Per drip | 5 | 0.05 | |
| Per recipient address | 5 | 0.05 | rolling 7 days |
| Per client IP | 10 | 0.1 | rolling 7 days |
| Per IPv4 /24 or IPv6 /48 | 20 | 0.2 | rolling 7 days |
| Global, all users | 25 | 0.25 | rolling 24 hours |
| Global, all users | 100 | 1 | calendar month (UTC), hard stop |
| Float reserve floor | 10 | 0.5 | never paid out |

How the caps work:

- Caps are amounts, not request counts. Every drip is written to an
  outflow ledger before it is broadcast, and each cap is an exact sum
  over that ledger. Failed sends (nothing broadcast) and reverted
  transactions do not count.
- Caps are checked inside a single-flight queue, so parallel requests
  cannot overshoot a cap.
- USDFC and FIL have separate budgets. A recipient can get 5 USDFC and
  0.05 FIL per 7 days.
- When the monthly cap is used up, drips stop until 00:00 UTC on the
  1st of next month.
- The reserve check uses the on-chain balance minus drips that are
  broadcast but not yet confirmed. A drip is refused if it would take
  the float below the floor (see Funding model).

## Captcha and API keys

There is no anonymous no-captcha path on mainnet. Every browser or
script request needs a Cloudflare Turnstile token rendered by the
mainnet page (action `mainnet-drip`). Tokens from the Calibration page
are not accepted.

Named integrators (for example SynapS3) can get an API key from the
operator for CI use. A key:

- skips the captcha,
- has its own per-key cap per asset and window (set when issued),
- replaces the per-IP and per-subnet caps (CI runners share IPs),
- still obeys the per-address cap, the global daily and monthly caps,
  the reserve floor and the kill switch.

Send it as `X-API-Key: <key>` or `Authorization: Bearer <key>`. Keys are
stored hashed and can be revoked at any time.

## Abuse detection

Every drip request is logged (time, client IP, /24 or /48, recipient,
asset, outcome). After each request these signals are checked. A rule
trips when the observed value is **more than** the threshold, and the
scope is blocked for 24 hours by default.

| Rule | Default threshold | Blocks |
| --- | --- | --- |
| Requests per IP per hour | 20 | IP |
| Distinct recipient addresses per IP per 24h | 3 | IP |
| Failed captchas per IP per hour | 5 | IP |
| Requests per /24 (or /48) per hour | 60 | subnet |
| Distinct recipient addresses per /24 (or /48) per 24h | 8 | subnet |
| Distinct verified IPs asking for one address per 24h | 4 | address |

Notes:

- The address rule only counts requests that passed the captcha, so
  nobody can get someone else's address blocked by spamming bad
  requests.
- API key traffic is excluded from the IP and subnet rules.
- We group by /24 and /48 instead of ASN; there is no ASN database on
  the host.
- Blocked requests get `403 blocked` with the scope and expiry. If you
  were blocked by mistake, contact the operator.

## Endpoints

All paths are relative to `https://faucet.reiers.io/mainnet/`.

### POST api/drip/usdfc and POST api/drip/fil

```http
POST /mainnet/api/drip/usdfc
Content-Type: application/json

{ "address": "0x...", "turnstileToken": "<token>" }
```

or, with an integrator key:

```shell
curl -s -X POST https://faucet.reiers.io/mainnet/api/drip/usdfc \
  -H 'content-type: application/json' \
  -H "X-API-Key: $PLUMBLINE_MAINNET_KEY" \
  -d '{"address":"0xYourAddress"}'
```

Success (200 confirmed, or 202 when the receipt was not seen within
60 seconds; the transfer is broadcast either way):

```json
{
  "ok": true,
  "network": "mainnet",
  "asset": "usdfc",
  "amount": "5",
  "to": "0x...",
  "status": "confirmed",
  "txHash": "0x...",
  "explorerUrl": "https://filecoin.blockscout.com/tx/0x...",
  "dryRun": false
}
```

`status` is one of `confirmed`, `submitted` (202), or `simulated`
(only when the operator runs the instance in dry-run mode; nothing is
sent).

Refusals always have `ok: false` and an `error` code. Rolling-window
refusals include `used`, `cap`, `windowSec`, `retryAfterSec` and
`retryAtUnix`, and set the `Retry-After` header.

| HTTP | error | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Body is not `{ address, turnstileToken }` |
| 400 | `invalid_address`, `testnet_address`, `native_address_unsupported`, `recipient_not_allowed` | Recipient not accepted |
| 400 | `captcha` | Missing or invalid Turnstile token |
| 401 | `invalid_api_key`, `revoked_api_key` | Bad API key |
| 403 | `blocked` | Abuse block on IP, subnet or address (has `scope`, `untilUnix`) |
| 429 | `address_cap` | Per-address cap reached |
| 429 | `ip_cap`, `subnet_cap` | Per-IP or per-subnet cap reached |
| 429 | `api_key_cap` | Per-key cap reached |
| 503 | `daily_cap_reached` | Global 24h budget used up |
| 503 | `monthly_cap_reached` | Global monthly budget used up (`retryAtUnix` = next month) |
| 503 | `preview_unfunded` | Float at or below its reserve floor (includes zero); has `funded: false`, `balance`, `floor`, `statusNote` |
| 503 | `faucet_dry` | Less than one drip above the floor, or no FIL for gas; same fields |
| 503 | `mainnet_paused` | Not yet activated (the default) or paused; has `statusNote` |
| 503 | `busy`, `rpc_unavailable` | Try again in a minute |
| 500 | `drip_failed`, `drip_reverted` | Send failed; does not count against caps |

### GET api/check?address=0x...

Remaining allowance for an address, per asset: `usedInWindow`, `cap`,
`remaining`, `eligibleNow`, `nextEligibleUnix`.

### GET api/info

Network, token, dispenser address, captcha site key, and the full cap
policy.

### GET api/status

Float and budget, for status pages:

```json
{
  "network": "mainnet",
  "paused": false,
  "funded": true,
  "activated": true,
  "label": "Mainnet preview",
  "statusNote": "Mainnet preview: not yet activated. Docs: ...",
  "dryRun": false,
  "rpcOk": true,
  "assets": {
    "usdfc": {
      "funded": true, "unfundedReason": null, "acceptingDrips": true,
      "balance": "118.5", "reserveFloor": "10", "available": "108.5", "inFlight": "0",
      "reserveBreach": false, "reserveLow": false,
      "monthToDate": "15", "monthlyCap": "100", "monthlyRemaining": "85", "monthlyCapReached": false,
      "last24h": "5", "dailyCap": "25", "dripsThisMonth": 3
    },
    "fil": { "...": "same shape" }
  },
  "abuse": { "activeBlocks": { "ip": 0, "subnet": 0, "address": 0 }, "blockedAttemptsTotal": 0 },
  "alerts": []
}
```

No client IPs are ever exposed here.

### GET metrics

Prometheus text format:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `plumbline_mainnet_up` | | 1 while serving |
| `plumbline_mainnet_paused` | | 1 when the kill switch is on |
| `plumbline_mainnet_dry_run` | | 1 in dry-run mode |
| `plumbline_mainnet_rpc_ok` | | 1 when the last balance read worked |
| `plumbline_mainnet_dispenser_balance_wei` | asset | Float balance |
| `plumbline_mainnet_reserve_floor_wei` | asset | Configured floor |
| `plumbline_mainnet_funded` | asset | 1 when the float can pay one drip above the floor |
| `plumbline_mainnet_accepting_drips` | asset | 1 when not paused, funded and budget left |
| `plumbline_mainnet_inflight_wei` | asset | Broadcast, not yet confirmed |
| `plumbline_mainnet_reserve_breach` | asset | 1 when drips are refused for the float (funded == 0) |
| `plumbline_mainnet_reserve_low` | asset | 1 when close to the floor |
| `plumbline_mainnet_outflow_month_wei` | asset | Sent this calendar month |
| `plumbline_mainnet_outflow_month_cap_wei` | asset | Monthly cap |
| `plumbline_mainnet_outflow_24h_wei` / `_cap_wei` | asset | Rolling 24h outflow and cap |
| `plumbline_mainnet_drips_total` | asset | Successful drips |
| `plumbline_mainnet_refused_total` | reason | Refusals by error code |
| `plumbline_mainnet_blocked_attempts_total` | | Requests refused by an active block |
| `plumbline_mainnet_abuse_trips_total` | rule | Abuse rule trips |
| `plumbline_mainnet_active_blocks` | kind | Active blocks (ip, subnet, address) |
| `plumbline_mainnet_queue_depth` | | Drips waiting or in flight |

## How this is tested

`pnpm test` runs unit tests for every cap, the monthly cap rollover, the
reserve floor (including in-flight amounts), the kill switch, the
queue, API keys, each abuse rule, block expiry, metrics and status.

`pnpm test:mainnet-rpc` adds tests against the real mainnet contract
bindings (the GitHub Actions workflow runs this on every push): chain
id 314, USDFC `symbol`/`decimals`/`name`/`balanceOf`, `transfer`
simulation with `eth_call` and `eth_estimateGas` from a funded mainnet
holder, a revert from an empty address, and the full HTTP flow (caps,
per-IP limit, abuse block, reserve floor and metrics) with the
dispenser in dry-run mode against live mainnet balances. Nothing is
signed or broadcast in CI.
