# Deploying the Calibration Faucet

Walkthrough for a production deployment like the canonical one at
<https://faucet.reiers.io>: Ubuntu 24.04, nginx, Cloudflare in front.
Adjust hostnames and paths for your own host.

Last verified end to end on a fresh Ubuntu 24.04 host on 2026-11-02
(successor dry run, see
[Reiers/plumbline reports](https://github.com/Reiers/plumbline/tree/main/reports)).
A fresh install takes about 15 minutes, most of it compiling
`better-sqlite3`.

## Prerequisites

- An Ubuntu 24.04 box with root SSH access.
- A DNS record for `faucet.<your-domain>`. With Cloudflare: proxied
  (orange cloud), SSL/TLS mode Full (strict), and a Cloudflare Origin CA
  certificate for the origin (see "TLS" below).
- A dispenser wallet on Filecoin Calibration with **tFIL** and, if you
  serve it, **USDFC**. Bootstrapping is covered below.
- A Cloudflare Turnstile site (free) for the captcha. Register at
  <https://www.cloudflare.com/products/turnstile/>; keep the site key
  (public) and secret key (private).
- Somewhere safe to keep secrets (`FAUCET_PK`, `TURNSTILE_SECRET`):
  an encrypted password vault. They never go into git, chat or email.

## Bootstrap a dispenser wallet

1. Generate a fresh keypair. Anything that produces a 32-byte hex key
   works. Without extra tools, after `pnpm install` (below):

   ```bash
   cd /opt/plumbline-faucet
   sudo -u faucet -H node --input-type=module -e \
     "import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'; const k=generatePrivateKey(); console.log(k, privateKeyToAccount(k).address)"
   ```

   Store the key in your vault straight away. `cast wallet new`
   (Foundry) works too.
2. Send tFIL to it. Public sources:
   - <https://faucet.calibnet.chainsafe-fil.io/funds.html>
   - <https://faucet.reiers.io> (the canonical Plumbline faucet)
3. For USDFC, open a Trove and mint at <https://stg.usdfc.net>: connect
   a wallet holding the dispenser key, deposit tFIL as collateral, mint.
4. The dispenser must hold more than `MIN_RESERVE_FIL + FIL_DRIP` (and
   `MIN_RESERVE_USDFC + USDFC_DRIP`) or drips of that asset fail with
   `503 faucet_dry`. Size the balance for the throughput you expect.

## Install on the box

```bash
ssh root@<plumbline-host>

# Tooling. Ubuntu's own nodejs package is v18 without npm; the faucet
# needs Node >= 20 (production runs 22), so use NodeSource.
apt-get update
apt-get install -y git build-essential python3 sqlite3 jq nginx
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt-get install -y nodejs
npm install -g pnpm@10
node -v && pnpm -v

# Faucet user (no shell, no home)
useradd --system --no-create-home --shell /usr/sbin/nologin faucet

# Code
mkdir -p /opt/plumbline-faucet
chown faucet:faucet /opt/plumbline-faucet
sudo -u faucet -H git clone https://github.com/Reiers/plumbline-faucet /opt/plumbline-faucet
cd /opt/plumbline-faucet
# Runs via tsx, so dev dependencies are needed. better-sqlite3 compiles
# from source here (needs build-essential + python3; 4 to 5 minutes on
# a slow core). Warnings about /home/faucet/.npmrc are harmless.
sudo -u faucet -H pnpm install --prod=false

# Config: start from the example, then fill in secrets and amounts.
sudo -u faucet -H cp .env.example .env
chmod 600 .env
$EDITOR .env
```

### `.env` reference

Every variable has a default in `src/config.ts`; only `FAUCET_PK` is
required. `.env.example` lists them all.

| Variable | Notes |
| --- | --- |
| `FAUCET_PK` | Dispenser private key, `0x` + 64 hex. Secret. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Without them the captcha is bypassed. Secret: `TURNSTILE_SECRET`. |
| `RPC_URL` | Calibration Lotus JSON-RPC. Default Glif. |
| `USDFC_ADDRESS` | USDFC ERC-20 on Calibration. |
| `CALL_ACTOR_FORWARDER` | Contract used for tFIL drips to native `t1`/`t3`/`t0` addresses. Default is the deployed Calibration instance. |
| `FIL_DRIP`, `USDFC_DRIP` | Amount per captcha or API-key drip, whole tokens. |
| `PUBLIC_FIL_DRIP`, `PUBLIC_USDFC_DRIP` | Amount per anonymous `/api/public/drip/*` drip. |
| `IP_RATE_LIMIT_SEC`, `ADDRESS_RATE_LIMIT_SEC` | Window length. |
| `MAX_DRIPS_PER_IP`, `MAX_DRIPS_PER_ADDRESS`, `MAX_PUBLIC_DRIPS_PER_IP` | Drips allowed per window, per asset. |
| `GLOBAL_RPS` | Per-IP burst limit on every route. |
| `MIN_RESERVE_FIL`, `MIN_RESERVE_USDFC` | Floor below which drips fail closed. Whole numbers only (`/metrics` parses them as integers). |
| `PORT`, `HOST` | Bind address. Use `HOST=127.0.0.1` behind nginx so the port is not reachable directly. |
| `TRUSTED_PROXY` | `true` behind nginx. The faucet then takes the left-most `X-Forwarded-For` entry as the client IP, so nginx must overwrite that header (see the vhost below). |
| `RATE_LIMIT_DB` | SQLite store for rate limits, API keys and stats. Use an absolute path. |
| `BRAND_NAME`, `BRAND_URL` | UI footer. |
| `LOG_LEVEL` | Pino level, default `info`. |

For a staging or dry-run instance, Cloudflare publishes
[Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/):
site key `1x00000000000000000000AA`, secret
`1x0000000000000000000000000000000AA`, token `XXXX.DUMMY.TOKEN.XXXX`.
They always pass. Never use them in production.

### systemd

```bash
cp /opt/plumbline-faucet/ops/plumbline-faucet.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now plumbline-faucet
curl -s http://127.0.0.1:<PORT>/healthz
```

The unit restarts the process 5 s after any exit.

## TLS: nginx behind Cloudflare

`ops/plumbline-faucet.nginx` is the vhost. It expects the Cloudflare
Origin CA certificate at `/etc/ssl/cloudflare/reiers.io.{crt,key}` and
the faucet on `127.0.0.1:8003`; edit the hostname, cert paths and port
to match your `.env`.

```bash
install -d -m 750 /etc/ssl/cloudflare
# Paste the Origin CA cert and key from Cloudflare (dashboard: SSL/TLS >
# Origin Server > Create Certificate). Key mode 600.
cp /opt/plumbline-faucet/ops/plumbline-faucet.nginx /etc/nginx/sites-available/faucet.<your-domain>
ln -sf /etc/nginx/sites-available/faucet.<your-domain> /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Keep `proxy_set_header X-Forwarded-For $remote_addr;` as shipped (not
`$proxy_add_x_forwarded_for`), so the faucet only ever sees the
address nginx resolved from `CF-Connecting-IP`.

Without Cloudflare, any TLS terminator works (for example Caddy with
`reverse_proxy 127.0.0.1:8003`), as long as it overwrites
`X-Forwarded-For` with the real client address.

## Backups

The SQLite store holds issued API keys and lifetime stats as well as
rate-limit windows, so back it up. `ops/backup.sh` takes an online,
integrity-checked, gzipped copy; the timer runs it daily at 03:00 UTC
and keeps 7 days.

```bash
cp /opt/plumbline-faucet/ops/plumbline-faucet-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now plumbline-faucet-backup.timer
systemctl start plumbline-faucet-backup.service      # first copy now
ls -l /var/backups/plumbline-faucet/
```

Copies stay on the box; pull them off-host too (for example
`rsync -a root@<plumbline-host>:/var/backups/plumbline-faucet/ <safe place>/`).
Restore steps are in the
[Plumbline runbook §8](https://github.com/Reiers/plumbline/blob/main/RUNBOOK.md#8-backups-and-restore).

## Verify end to end

```bash
# 1. Liveness + dispenser balances (ok:true even when balances are 0)
curl -s https://faucet.<your-domain>/healthz | jq

# 2. Public metadata (rendered by the UI)
curl -s https://faucet.<your-domain>/api/info | jq

# 3. Prometheus metrics; low_reserve 1 means drips of that asset will 503
curl -s https://faucet.<your-domain>/metrics | grep low_reserve

# 4. A real drip. Get a Turnstile token from the browser UI, or use an
#    API key (Authorization: Bearer pk_...). Takes 30 to 70 s.
curl -s -X POST https://faucet.<your-domain>/api/drip/fil \
  -H 'content-type: application/json' \
  -d '{"address":"0x...","turnstileToken":"<token>"}' | jq
```

A good drip returns `"ok": true` and `"verified": true`.

## Operations

### Logs

```bash
journalctl -u plumbline-faucet -f --output=cat
```

Drip-success lines look like:

```
{"level":30,"asset":"fil","recipient":"0x...","ip":"...","apiKey":null,"txHash":"0x...","verified":true,"msg":"drip ok"}
```

### API keys

```bash
cd /opt/plumbline-faucet
sudo -u faucet -H pnpm run keygen create --name "<partner>-ci" --max-drips 50
sudo -u faucet -H pnpm run keygen list
sudo -u faucet -H pnpm run keygen revoke pk_...
```

Do not put `--` between `keygen` and the subcommand; pnpm passes it
through and the tool prints its help instead. Works while the faucet
is running.

### Top up the dispenser

When the dispenser drops below `MIN_RESERVE_*`, drips of that asset
return `503 faucet_dry`. Send more tFIL to the dispenser address, or
mint more USDFC from a Trove against the dispenser key.

### Rotate the dispenser key

1. Generate the new key (see "Bootstrap a dispenser wallet"), store it
   in the vault.
2. Edit `/opt/plumbline-faucet/.env` and set the new `FAUCET_PK`.
3. `systemctl restart plumbline-faucet`, then check `/healthz` shows
   the new dispenser address.
4. Move the old balance to the new dispenser. Without Foundry, from
   `/opt/plumbline-faucet` (key passed via environment, not on the
   command line history):

   ```bash
   read -rs OLD_PK; export OLD_PK NEW_ADDR=0x<new dispenser> RPC_URL=https://api.calibration.node.glif.io/rpc/v1
   sudo -E -u faucet -H node --input-type=module -e '
   import { createWalletClient, createPublicClient, http, parseEther } from "viem"
   import { privateKeyToAccount } from "viem/accounts"
   import { filecoinCalibration } from "viem/chains"
   const account = privateKeyToAccount(process.env.OLD_PK)
   const pub = createPublicClient({ chain: filecoinCalibration, transport: http(process.env.RPC_URL) })
   const wal = createWalletClient({ account, chain: filecoinCalibration, transport: http(process.env.RPC_URL) })
   const value = (await pub.getBalance({ address: account.address })) - parseEther("1") // leave gas
   const hash = await wal.sendTransaction({ to: process.env.NEW_ADDR, value })
   console.log(hash, (await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })).status)'
   unset OLD_PK
   ```

   USDFC is an ERC-20: move it with a `transfer` call from the old key
   (MetaMask is simplest), or leave it and mint fresh against the new key.

### Change rate limits or drip amounts

Edit `/opt/plumbline-faucet/.env` and `systemctl restart plumbline-faucet`.
SQLite state persists across restarts, so existing cooldowns are honored.

### Reset rate limits (admin)

```bash
systemctl stop plumbline-faucet
sqlite3 /opt/plumbline-faucet/rate-limits.sqlite 'DELETE FROM ip_drips; DELETE FROM address_drips;'
systemctl start plumbline-faucet
```

Drops every cooldown for everyone but keeps API keys and stats. Only
for emergencies or testing.

## Builder API v1

The `/api/v1` endpoints need no extra service. Optional settings are
listed in `.env.example` under "Builder API v1". If Calix runs on the
same host, point the server at the local Calix API so
`/api/v1/network` and `/api/v1/sp` skip the public round trip:

```bash
CALIX_URL=http://127.0.0.1:<calix-api-port>
CALIX_PUBLIC_URL=https://calix.reiers.io
```

On first start the server adds a nullable `amount_wei` column to the
`recent_drips` table. Existing rows keep a null amount.

Smoke test after a deploy:

```bash
curl -s https://<your-host>/api/v1 | jq .apiVersion            # "1"
curl -s https://<your-host>/api/v1/faucet/status | jq .healthy
curl -s https://<your-host>/api/v1/network | jq '{healthy, stale, fetchedAt}'
curl -s https://<your-host>/api/v1/sp | jq '.targets[0]'
curl -sI https://<your-host>/api/v1 | grep -i -E 'ratelimit|access-control-allow-origin'
```

| Symptom | Cause | Fix |
| --- | --- | --- |
| `502 upstream_unavailable` on `/api/v1/network` or `/api/v1/sp` | Calix unreachable for longer than `UPSTREAM_STALE_MAX_SEC` | Check Calix, then `CALIX_URL` |
| `stale: true` in `/api/v1/network` | Calix failing, last good value served | Same as above |

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503 faucet_dry` | Dispenser below reserve + drip | Top up |
| `400 captcha` with `reason` `missing_token` | Client sent no Turnstile token | Use the UI or an API key |
| `400 captcha` with `invalid-input-secret` | `TURNSTILE_SECRET` wrong | Re-check Cloudflare config |
| nginx 502 | Node process down or restarting | `journalctl -u plumbline-faucet -n 200`; systemd restarts it within about 10 s |
| `ok: true` but `verified: false` | Balance read raced the RPC; tx usually landed | Check the tx hash on a Calibration explorer |
| Drip submitted but tx never lands | RPC slow or down | Switch `RPC_URL` to another Calibration RPC and restart |
| Status page green but drips 503 | `/healthz` is ok even at zero balance | Watch `plumbline_faucet_low_reserve` |
| Startup fails with `Missing required env var: FAUCET_PK` | `.env` missing or not readable by `faucet` | Check owner `faucet`, mode 600 |
