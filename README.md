<div align="center">
  <h1>Calibration Faucet 💧</h1>
  <p>Public Filecoin Calibration testnet faucet. Drips <strong>tFIL</strong> + <strong>USDFC</strong>.</p>
  <p><sub>Calibration testnet only. Don't deploy this to mainnet.</sub></p>
</div>

---

## What this is

A public-facing faucet for the Filecoin Calibration testnet. One HTTP
call (or one click on the landing page) drips both:

- **tFIL** — the native gas token on Calibration
- **USDFC** — the Filecoin Calibration stablecoin used by Filecoin Pay,
  FWSS, and any application contracts that settle in USDFC

Built to support testing of contracts that need both rails working
(payments, deposits, fee routing) without forcing users through the
manual Trove-collateralization flow on `stg.usdfc.net` or hopping
between half-deprecated faucets.

The canonical public deployment is at
<https://faucet.reiers.io>. The repo itself is domain-neutral; brand
name and footer URL are env-driven (`BRAND_NAME`, `BRAND_URL`).
Leave `BRAND_URL` blank for a generic deployment with no operator
link in the footer.

## Endpoints

```
GET  /                landing page (HTML)
GET  /healthz         liveness probe + dispenser balances
GET  /api/info        public faucet metadata + live dispenser balances
GET  /api/stats       lifetime + 24h aggregate counters
GET  /api/recent      last N drips (default 10, max 50)
POST /api/drip        { address, turnstileToken } → drip
```

### `POST /api/drip`

```bash
curl -X POST https://<your-host>/api/drip \
  -H 'content-type: application/json' \
  -d '{
    "address": "0xabc...",
    "turnstileToken": "..."
  }'
```

Success:

```json
{
  "ok": true,
  "filTxHash":   "0x...",
  "usdfcTxHash": "0x...",
  "filAmount":   "5",
  "usdfcAmount": "100"
}
```

Errors:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request`             | Body shape invalid |
| 400 | `captcha`                 | Turnstile failed (`reason` carries the code) |
| 429 | `ip_rate_limited`         | Same IP requested in last `IP_RATE_LIMIT_SEC` |
| 429 | `address_rate_limited`    | Same address requested in last `ADDRESS_RATE_LIMIT_SEC` |
| 503 | `faucet_dry`              | Dispenser balance below the configured reserve |
| 500 | `drip_failed`             | RPC / chain error during the transfer |

## Default drip + cooldowns

| Setting | Default |
| --- | --- |
| tFIL per drip | 5 |
| USDFC per drip | 100 |
| Per-IP cooldown | 24h |
| Per-address cooldown | 24h |
| Global per-IP burst | 5 req/sec |
| Min reserve | 20 tFIL + 500 USDFC (faucet refuses drips below) |

Every value is overridable via env. See [`.env.example`](.env.example).

## Local development

```bash
pnpm install

# Required: dispenser key with both tFIL and USDFC balances on Calibration.
# Get tFIL from https://faucet.calibnet.chainsafe-fil.io/funds.html
# Get USDFC by collateralizing tFIL at https://stg.usdfc.net (Trove)
cp .env.example .env
# edit .env, set FAUCET_PK

pnpm dev
# faucet listening on http://127.0.0.1:8003

curl http://127.0.0.1:8003/healthz
curl -X POST http://127.0.0.1:8003/api/drip \
  -H 'content-type: application/json' \
  -d '{"address":"0x...your-test-address..."}'
```

In dev with no `TURNSTILE_SECRET` set, captcha is bypassed and the
server logs a warning on startup. **Never run a public deployment
without Turnstile.**

## Production deploy

See [`docs/deploy.md`](docs/deploy.md) for the full Hetzner + Caddy
walkthrough.

The short version:

1. Provision a Linux box, install Node 22 + pnpm.
2. `git clone` this repo into `/opt/calibration-faucet`.
3. Drop `.env` with `FAUCET_PK`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`.
4. Install the systemd unit at [`ops/calibration-faucet.service`](ops/calibration-faucet.service).
5. Reverse-proxy via Caddy (or any TLS terminator) at the public hostname.

## Security and abuse model

- **Single hot wallet.** The dispenser key is the only thing the faucet
  signs with. Compromise of `FAUCET_PK` drains the dispenser, full stop.
  Keep balances bounded (`MIN_RESERVE_*` enforces a floor below which
  drips fail closed; cap the *total* dispenser balance via top-ups, not
  by the faucet).
- **Captcha-first, rate-limit-second.** Cloudflare Turnstile is the
  primary defense against bot floods. The SQLite per-IP and per-address
  cooldowns are the secondary defense. A burst limiter at the Fastify
  layer catches obvious DoS attempts before they reach SQLite.
- **No request bodies are logged.** Drip responses log only addresses
  and tx hashes; turnstile tokens, headers, and IPs are never
  persisted to logs at info level.
- **`X-Forwarded-For` honored only behind a trusted proxy.** When
  `TRUSTED_PROXY=true` the server reads the X-Forwarded-For chain;
  otherwise it falls back to the socket address. Set this correctly
  for your deployment topology or rate limiting will be either bypassed
  or applied to the wrong client.

## Roadmap

- [ ] Auto-refill from external Calibration faucets when the dispenser
      tFIL drops below a threshold (cron + chainsafe drip)
- [ ] USDFC top-up via owned Troves rather than manual top-up
- [ ] Discord / X verification path for higher-tier drips
- [ ] Public dashboard: drip volume, dispenser balance, recent grants

## License

MIT
