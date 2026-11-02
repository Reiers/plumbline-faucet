# Mainnet preview: operator activation runbook

How to bring up, run, pause, rotate and shut down the Plumbline mainnet
preview faucet. Policy and public API: [mainnet-preview.md](mainnet-preview.md).

The mainnet preview is a **second instance** of this repo, selected by
`NETWORK=mainnet`. It never shares a key, database, port, env file or
systemd unit with the Calibration faucet. The Calibration instance is
not touched by anything in this runbook.

| | Calibration (existing) | Mainnet preview (new) |
| --- | --- | --- |
| Directory | `/opt/plumbline-faucet` | `/opt/plumbline-faucet-mainnet` |
| Unix user | `faucet` | `faucet-mainnet` |
| Unit | `plumbline-faucet.service` | `plumbline-faucet-mainnet.service` |
| Port | existing | `127.0.0.1:8006` |
| Env | `.env` (`FAUCET_PK`, ...) | `.env` (`MAINNET_*` only) |
| DB | `rate-limits.sqlite` | `mainnet.sqlite` |
| Public URL | `https://faucet.reiers.io/` | `https://faucet.reiers.io/mainnet/` |

Commands below run on `<plumbline-host>` as root unless noted. Edits to
`.env` run as `faucet-mainnet` so the file keeps its owner and mode 600.

## 0. Before you start

The float is **loaded by the operator at activation**. The instance
ships with the kill switch ON ("Mainnet preview (not yet activated)")
and is safe to run with any float, including zero: every drip gets a
clear `503` (`mainnet_paused`, `preview_unfunded` or `faucet_dry`)
with a notice. See "Funding model" in
[mainnet-preview.md](mainnet-preview.md#funding-model).

- Maximum exposure (defaults): **100 USDFC + 1 FIL per month**, the
  hard monthly cap, about 101 USD per month. Float to fund at
  activation: **110 USDFC + 1.5 FIL** (one month of cap plus the
  reserve floor, which is never paid out).
  - Gas is paid from the FIL float. A USDFC transfer is about 44M gas
    units; at current fees all drips in a month cost well under
    0.001 FIL.
  - Worst case if the key leaked: the whole float. Caps protect
    against abuse through the API, not against key theft, so keep the
    float near one month of cap.
- A Cloudflare Turnstile widget for `faucet.reiers.io`. A separate
  widget from Calibration is recommended (separate analytics and
  secret). Reusing the Calibration widget also works, because the
  mainnet page uses action `mainnet-drip` and the server rejects
  tokens without it.
- Optional: an alert webhook URL (Slack/Discord-style incoming webhook
  or any endpoint that accepts JSON).
- Optional: `MAINNET_STATUS_NOTE` (text shown on the page, in `api/info`,
  `api/status` and in refusals).

## 1. Install the second instance

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin faucet-mainnet
mkdir -p /opt/plumbline-faucet-mainnet
chown faucet-mainnet:faucet-mainnet /opt/plumbline-faucet-mainnet
sudo -u faucet-mainnet -H git clone https://github.com/Reiers/plumbline-faucet /opt/plumbline-faucet-mainnet
cd /opt/plumbline-faucet-mainnet
sudo -u faucet-mainnet -H pnpm install --frozen-lockfile
sudo -u faucet-mainnet -H pnpm test        # unit tests, no network
sudo -u faucet-mainnet -H pnpm test:mainnet-rpc   # optional, read-only mainnet checks
```

Create the env file from the template:

```bash
cd /opt/plumbline-faucet-mainnet
install -m 600 -o faucet-mainnet -g faucet-mainnet ops/mainnet.env.example .env
$EDITOR .env    # Turnstile keys, webhook, leave MAINNET_FAUCET_PK empty for now
```

## 2. Generate the dispenser key

Generate it on the host so it never leaves the box except as an
offline backup. This writes the key into `.env` and prints only the
address:

```bash
cd /opt/plumbline-faucet-mainnet
sudo -u faucet-mainnet sed -i '/^MAINNET_FAUCET_PK=/d' .env
sudo -u faucet-mainnet -H node --input-type=module -e "
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import fs from 'node:fs'
const pk = generatePrivateKey()
fs.appendFileSync('.env', 'MAINNET_FAUCET_PK=' + pk + '\n')
console.log('dispenser address:', privateKeyToAccount(pk).address)
"
chmod 600 .env
ls -l .env    # must be -rw------- faucet-mainnet faucet-mainnet
```

Back up the key offline (password manager). Never reuse the
Calibration `FAUCET_PK`; boot refuses if they are equal.

## 3. Bring it up disabled (the default)

You can finish steps 5 and 6 before the float is loaded. With the
shipped `.env` (`MAINNET_KILL_SWITCH=1`) and a zero float:

- the page, `api/info` and `api/status` show "Mainnet preview, not
  yet activated" (`activated: false`),
- every drip returns `503 mainnet_paused` with the notice,
- `api/status` shows `paused: true`, `funded: false`, balances,
  floors, month-to-date outflow and caps,
- `/metrics` shows `plumbline_mainnet_paused 1` and
  `plumbline_mainnet_funded{asset=...} 0`,
- no reserve alerts are sent while paused (an empty float is
  expected); one `kill_switch` info alert is sent at start.

Optional dry run: set `MAINNET_DRY_RUN=1` to simulate every drip
against mainnet (`eth_call` / `eth_estimateGas`) without broadcasting.
Simulated drips count against caps while in dry run and are ignored
once dry run is off.

## 4. Load the float (activation)

Send the float to the dispenser address (printed in step 2, also in
`GET /mainnet/api/info` as `dispenser`):

- FIL from any mainnet wallet, to the 0x or f410f form of the address.
- USDFC (token `0x80B98d3aa09ffff255c3ba4A241111Ff1262F045`), for
  example bought on a DEX or minted from a USDFC trove.

Both are needed: USDFC drips pay gas in FIL. An asset is `funded` once
at least one drip is available above its floor. Record a withdrawal
address for the float next to the dispenser key backup.

Check:

```bash
curl -s https://faucet.reiers.io/mainnet/api/status | jq '{activated, paused, funded, assets: (.assets | map_values({funded, balance, reserveFloor, available, monthToDate, monthlyCap}))}'
```

## 5. systemd unit

```bash
cp /opt/plumbline-faucet-mainnet/ops/plumbline-faucet-mainnet.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now plumbline-faucet-mainnet
systemctl status plumbline-faucet-mainnet
journalctl -u plumbline-faucet-mainnet -n 50 --output=cat
curl -s http://127.0.0.1:8006/healthz
```

Boot is fail-closed and exits with code 2 (no restart loop) when:
NETWORK is not mainnet, the Turnstile keys are missing, the key is
missing (outside dry run), the key equals the Calibration key, the RPC
URL looks like Calibration, a cap is below the drip amount, or the RPC
reports a chain id other than 314.

## 6. nginx

Add the mainnet location to the existing `faucet.reiers.io` server
block (the 443 one), next to `location /`:

```bash
cp /opt/plumbline-faucet-mainnet/ops/nginx-mainnet-location.conf /etc/nginx/snippets/plumbline-mainnet.conf
# then inside the server { ... } block for faucet.reiers.io:
#     include snippets/plumbline-mainnet.conf;
nginx -t && systemctl reload nginx
```

The snippet strips the `/mainnet` prefix, passes the real client IP
(after Cloudflare `real_ip`) as `X-Forwarded-For`, and keeps the read
timeout under Cloudflare's 100 second origin limit. No DNS change is
needed. A separate subdomain also works: proxy it to
`127.0.0.1:8006` at `/` instead.

## 7. Enable drips and verify

Only after the float shows `funded: true` for both assets. Enabling is
one flag:

(Optionally also replace `MAINNET_STATUS_NOTE`, whose default reads "Mainnet
preview: not yet activated.", with text for the live preview.)

```bash
cd /opt/plumbline-faucet-mainnet
sudo -u faucet-mainnet sed -i 's/^MAINNET_KILL_SWITCH=.*/MAINNET_KILL_SWITCH=0/' .env
sudo -u faucet-mainnet sed -i 's/^MAINNET_DRY_RUN=.*/MAINNET_DRY_RUN=0/' .env   # if you used dry run
systemctl restart plumbline-faucet-mainnet

B=https://faucet.reiers.io/mainnet
curl -s $B/healthz                 # network mainnet, chainId 314, paused false, dryRun false
curl -s $B/api/info | jq '{activated, label}'   # true, "Mainnet preview"
curl -s $B/api/info | jq .policy   # caps as intended
curl -s $B/api/status | jq .       # funded true, balances, floors, month-to-date
curl -s $B/metrics | grep -v '^#'
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/drip/usdfc \
  -H 'content-type: application/json' -d '{"address":"0x0000000000000000000000000000000000000001"}'
# expect 400 (captcha)
```

Then open `https://faucet.reiers.io/mainnet/` in a browser and do one
real USDFC and one FIL drip to an address you control. Check the
explorer link, then `api/status` (month-to-date should be 5 USDFC and
0.05 FIL) and `pnpm mainnet:admin summary`.

If the float runs out later, drips stop on their own with
`preview_unfunded` or `faucet_dry` and a `reserve_breach` alert is
sent; nothing else is needed until the float is topped up.

## 8. Monitoring

- Prometheus: scrape `https://faucet.reiers.io/mainnet/metrics` as job
  `plumbline-mainnet` and load `ops/prometheus-mainnet-alerts.yml`.
- Low-reserve hook: set `MAINNET_ALERT_WEBHOOK_URL`. The monitor loop
  (every 60s) posts JSON for `reserve_breach`, `reserve_low`,
  `monthly_cap_80`, `monthly_cap_reached`, `kill_switch`, `rpc_error`
  and each new abuse auto-block. Each alert repeats at most once per
  hour. Alerts are always logged as `mainnet_alert` lines in the
  journal, webhook or not.
- Status page: `GET /mainnet/api/status` is safe to poll publicly (no
  client IPs).
- Structured logs: `mainnet_drip`, `mainnet_refused`,
  `mainnet_abuse_trip`, `mainnet_drip_failed`, `mainnet_alert`:

```bash
journalctl -u plumbline-faucet-mainnet -f --output=cat | grep -E 'mainnet_(drip|refused|abuse|alert)'
```

## 9. Kill switch

The kill switch is ON by default (`MAINNET_KILL_SWITCH=1`, and also
when the variable is unset or empty). `MAINNET_KILL_SWITCH=0` is the
only way to enable drips.

Immediate, no restart (checked on every request):

```bash
touch /opt/plumbline-faucet-mainnet/MAINNET_KILL      # pause
rm /opt/plumbline-faucet-mainnet/MAINNET_KILL         # resume
```

Persistent, survives restarts and deploys:

```bash
sudo -u faucet-mainnet sed -i 's/^MAINNET_KILL_SWITCH=.*/MAINNET_KILL_SWITCH=1/' /opt/plumbline-faucet-mainnet/.env
systemctl restart plumbline-faucet-mainnet
```

While paused every drip returns `503 mainnet_paused`; read endpoints
keep working and `plumbline_mainnet_paused` is 1. Last resort:
`systemctl stop plumbline-faucet-mainnet`.

## 10. Caps and integrator keys

Change caps in `.env` and restart. The ledger persists, so windows and
the month-to-date total carry over. Boot rejects inconsistent caps.

Issue an API key to a named integrator (shown once):

```bash
cd /opt/plumbline-faucet-mainnet
sudo -u faucet-mainnet -H pnpm -s mainnet:admin key create --name synaps3 \
  --cap-usdfc 50 --cap-fil 0.5 --window-sec 604800 --notes "SynapS3 CI"
sudo -u faucet-mainnet -H pnpm -s mainnet:admin key list
sudo -u faucet-mainnet -H pnpm -s mainnet:admin key revoke --name synaps3
```

Keyed traffic still counts against the global daily and monthly caps,
so size key caps below the monthly cap.

Blocks:

```bash
sudo -u faucet-mainnet -H pnpm -s mainnet:admin block list
sudo -u faucet-mainnet -H pnpm -s mainnet:admin block remove --kind ip --value 203.0.113.7
sudo -u faucet-mainnet -H pnpm -s mainnet:admin block add --kind address --value 0x... --hours 168 --reason "manual"
sudo -u faucet-mainnet -H pnpm -s mainnet:admin ledger --limit 20
sudo -u faucet-mainnet -H pnpm -s mainnet:admin summary
```

## 11. Rotate the dispenser key

1. Pause: `touch MAINNET_KILL`.
2. Generate a new key as in step 2, but write it to a scratch file
   first and note the new address. Keep the old key in `.env` for now.
3. Drain the old float to the new address:
   ```bash
   sudo -u faucet-mainnet -H pnpm -s mainnet:drain --to 0xNEW     # plan + simulate
   sudo -u faucet-mainnet -H pnpm -s mainnet:drain --to 0xNEW --execute
   ```
4. Replace `MAINNET_FAUCET_PK` in `.env` with the new key, shred the
   scratch file, `systemctl restart plumbline-faucet-mainnet`.
5. Check `/healthz` shows the new dispenser and `api/status` shows the
   float, then `rm MAINNET_KILL`.

If the old key may be compromised, skip the pause and drain
immediately to a wallet you control.

## 12. Withdraw the float, drain, shut down

Withdraw all or part of the float to a withdrawal address (the one
recorded in step 4):

```bash
cd /opt/plumbline-faucet-mainnet
touch MAINNET_KILL                                                  # pause so no drip races the drain
sudo -u faucet-mainnet -H pnpm -s mainnet:drain --to 0xWITHDRAWAL_ADDRESS                         # plan + simulate, everything
sudo -u faucet-mainnet -H pnpm -s mainnet:drain --to 0xWITHDRAWAL_ADDRESS --usdfc 50 --fil 0.5    # plan + simulate, partial
sudo -u faucet-mainnet -H pnpm -s mainnet:drain --to 0xWITHDRAWAL_ADDRESS --execute               # send (add the amounts for partial)
rm MAINNET_KILL                                                     # resume, if funds remain
```

The drain sends USDFC first, then FIL, and keeps 0.01 FIL back for gas
by default (`--keep-fil`). It refuses to execute in dry-run mode.

Full shutdown:

```bash
sudo -u faucet-mainnet sed -i 's/^MAINNET_KILL_SWITCH=.*/MAINNET_KILL_SWITCH=1/' .env
sudo -u faucet-mainnet -H pnpm -s mainnet:drain --to 0xWITHDRAWAL_ADDRESS --execute
systemctl disable --now plumbline-faucet-mainnet
# remove the include line from the faucet.reiers.io nginx server block
nginx -t && systemctl reload nginx
```

Keep `mainnet.sqlite` as the audit trail of all mainnet outflow.

## 13. Upgrades

```bash
cd /opt/plumbline-faucet-mainnet
sudo -u faucet-mainnet -H git pull --ff-only
sudo -u faucet-mainnet -H pnpm install --frozen-lockfile
sudo -u faucet-mainnet -H pnpm test
systemctl restart plumbline-faucet-mainnet
```

The Calibration instance in `/opt/plumbline-faucet` is upgraded
separately and is not affected.
