# Deploying the Calibration Faucet

Walkthrough for the canonical deployment at
<https://<your-host>>. Adjust paths / hostnames for your own
host.

## Prerequisites

- A Linux box (the canonical deployment runs on Hetzner Helsinki,
  alongside other services).
- A DNS record pointing `faucet.<your-domain>` at the box.
- A dispenser wallet on Filecoin Calibration with both **tFIL** and
  **USDFC** balances. Bootstrapping covered below.
- A Cloudflare Turnstile site (free) for the captcha. Register at
  <https://www.cloudflare.com/products/turnstile/>; capture the site
  key (public) and secret key (private).

## Bootstrap a dispenser wallet

1. Generate a fresh keypair (anything that produces a 32-byte hex key
   works; `cast wallet new` is convenient).
2. Send tFIL to it. Public sources:
   - <https://faucet.calibnet.chainsafe-fil.io/funds.html> (1000 tFIL/24h)
   - Any other community Calibration faucet
3. Open a Trove and mint USDFC. <https://stg.usdfc.net> walks through
   it: connect MetaMask, deposit tFIL as collateral, mint USDFC.
4. Confirm the dispenser holds at least
   `MIN_RESERVE_FIL + N · FIL_DRIP` and
   `MIN_RESERVE_USDFC + N · USDFC_DRIP` for whatever throughput you
   expect.

## Install on the box

```bash
ssh root@your-host

# Tooling
apt-get update
apt-get install -y nodejs git build-essential
npm install -g pnpm

# Faucet user (no shell)
useradd --system --no-create-home --shell /usr/sbin/nologin faucet

# Code
mkdir -p /opt/plumbline-faucet
chown faucet:faucet /opt/plumbline-faucet
sudo -u faucet -H git clone https://github.com/Reiers/plumbline-faucet /opt/plumbline-faucet
cd /opt/plumbline-faucet
sudo -u faucet -H pnpm install --prod=false   # we run via tsx, need devdeps

# Config
sudo -u faucet -H install -m 0600 /dev/null /opt/plumbline-faucet/.env
$EDITOR /opt/plumbline-faucet/.env
chown faucet:faucet /opt/plumbline-faucet/.env
chmod 600 /opt/plumbline-faucet/.env

# systemd unit
cp ops/plumbline-faucet.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now plumbline-faucet
systemctl status plumbline-faucet
```

## TLS via Caddy

Add to `/etc/caddy/Caddyfile`:

```caddy
faucet.your-domain.example {
    reverse_proxy 127.0.0.1:8003
}
```

```bash
systemctl reload caddy
curl -I https://faucet.your-domain.example/
```

Caddy auto-provisions Let's Encrypt for the hostname.

## Verify end-to-end

```bash
# 1. Liveness + dispenser balances
curl -s https://faucet.your-domain.example/healthz | jq

# 2. Public metadata (rendered by the UI)
curl -s https://faucet.your-domain.example/api/info | jq

# 3. Drip from a real address — should land both txs in ~30s
curl -s -X POST https://faucet.your-domain.example/api/drip \
  -H 'content-type: application/json' \
  -d '{"address":"0x...","turnstileToken":"<from a browser>"}' | jq
```

For programmatic clients, generate a Turnstile token via the
[invisible widget](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
or use a managed challenge — the API will not accept drips without one
when `TURNSTILE_SECRET` is set.

## Operations

### Logs

```bash
journalctl -u plumbline-faucet -f --output=cat
```

Drip-success lines look like:

```
{"level":30,"msg":"drip ok","recipient":"0x...","filTxHash":"0x...","usdfcTxHash":"0x..."}
```

### Top up the dispenser

When the dispenser drops below `MIN_RESERVE_*`, the faucet starts
returning `503 faucet_dry`. Either:

- Send more tFIL from another address.
- Mint more USDFC from a Trove (or open a new Trove against the same
  dispenser key).

### Rotate the dispenser key

1. Provision a new key, fund it.
2. Edit `/opt/plumbline-faucet/.env` (set new `FAUCET_PK`).
3. `systemctl restart plumbline-faucet`.
4. Drain the old key with a manual `cast send` to the new dispenser if
   needed.

### Change rate limits or drip amounts

Edit `/opt/plumbline-faucet/.env` and `systemctl restart`. SQLite
state persists across restarts, so existing cooldowns are honored.

### Reset rate limits (admin)

```bash
sudo -u faucet -H rm /opt/plumbline-faucet/rate-limits.sqlite*
systemctl restart plumbline-faucet
```

(Drops every cooldown for everyone; only do this for emergencies or
during testing.)

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503 faucet_dry` | Dispenser below reserve | Top up |
| `400 captcha turnstile_invalid-input-secret` | `TURNSTILE_SECRET` wrong | Re-check Cloudflare config |
| Nginx/Caddy 502 | Node process died | `journalctl -u plumbline-faucet -n 200` |
| Drip submitted but tx never lands | Glif RPC slow/down | Switch `RPC_URL` to a different Calibration RPC |
| All requests 429 from a real user behind NAT | Per-IP cooldown collides with their NAT pool | Lower `IP_RATE_LIMIT_SEC` or remove per-IP and rely on per-address only (raise `ADDRESS_RATE_LIMIT_SEC`) |
