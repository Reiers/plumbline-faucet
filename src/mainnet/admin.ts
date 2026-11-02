// SPDX-License-Identifier: MIT
//
// Operator CLI for the mainnet preview. Works directly on the mainnet
// SQLite file (MAINNET_DB, default ./mainnet.sqlite). Safe to run while
// the service is up (WAL mode).
//
//   pnpm mainnet:admin key create --name synaps3 [--cap-usdfc 50] [--cap-fil 0.5] [--window-sec 604800] [--notes "..."]
//   pnpm mainnet:admin key list
//   pnpm mainnet:admin key revoke --name synaps3
//   pnpm mainnet:admin key enable --name synaps3
//   pnpm mainnet:admin block list
//   pnpm mainnet:admin block add --kind ip|subnet|address --value <v> [--hours 24] [--reason "..."]
//   pnpm mainnet:admin block remove --kind ip|subnet|address --value <v>
//   pnpm mainnet:admin ledger [--limit 20]
//   pnpm mainnet:admin summary

import 'dotenv/config'
import { ASSETS, fromMicro, toMicro } from './config.js'
import { MainnetLedger, monthStartUnix, type BlockKind } from './ledger.js'

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next
        i++
      } else out[a.slice(2)] = 'true'
    }
  }
  return out
}

function die(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(msg)
  process.exit(1)
}

export function runAdmin(argv: string[], dbPath = process.env.MAINNET_DB ?? './mainnet.sqlite'): string {
  const [group, cmd, ...rest] = argv
  const f = flags(rest)
  const now = Math.floor(Date.now() / 1000)
  const ledger = new MainnetLedger(dbPath, { countSimulated: (process.env.MAINNET_DRY_RUN ?? '') === '1' })
  try {
    if (group === 'key' && cmd === 'create') {
      if (!f.name) die('--name is required')
      const key = ledger.createApiKey({
        name: f.name,
        capUsdfcMicro: toMicro(f['cap-usdfc'] ?? '50', 'cap-usdfc'),
        capFilMicro: toMicro(f['cap-fil'] ?? '0.5', 'cap-fil'),
        windowSec: Number(f['window-sec'] ?? 7 * 86_400),
        notes: f.notes ?? null,
        nowUnix: now,
      })
      return `created key for "${f.name}". Shown once, store it now:\n${key}`
    }
    if (group === 'key' && cmd === 'list') {
      return JSON.stringify(
        ledger.listApiKeys().map((k) => ({
          name: k.name,
          enabled: k.enabled,
          capUsdfc: fromMicro(k.capUsdfcMicro),
          capFil: fromMicro(k.capFilMicro),
          windowSec: k.windowSec,
          usedUsdfc: fromMicro(ledger.sumOutflow({ asset: 'usdfc', sinceUnix: now - k.windowSec, apiKeyId: k.id })),
          usedFil: fromMicro(ledger.sumOutflow({ asset: 'fil', sinceUnix: now - k.windowSec, apiKeyId: k.id })),
          notes: k.notes,
        })),
        null,
        2,
      )
    }
    if (group === 'key' && (cmd === 'revoke' || cmd === 'enable')) {
      if (!f.name) die('--name is required')
      const ok = ledger.setApiKeyEnabled(f.name, cmd === 'enable')
      return ok ? `${cmd}d "${f.name}"` : `no key named "${f.name}"`
    }
    if (group === 'block' && cmd === 'list') {
      return JSON.stringify(ledger.listBlocks(now), null, 2)
    }
    if (group === 'block' && (cmd === 'add' || cmd === 'remove')) {
      const kind = f.kind as BlockKind
      if (!['ip', 'subnet', 'address'].includes(kind) || !f.value) die('--kind ip|subnet|address and --value are required')
      if (cmd === 'remove') return ledger.removeBlock(kind, f.value) ? 'removed' : 'no such block'
      const hours = Number(f.hours ?? 24)
      ledger.addBlock({ kind, value: f.value, reason: f.reason ?? 'manual', createdUnix: now, untilUnix: now + Math.round(hours * 3600), source: 'manual' })
      return `blocked ${kind} ${f.value} for ${hours}h`
    }
    if (group === 'ledger') {
      const limit = Number(cmd === '--limit' ? rest[0] : f.limit ?? 20)
      return JSON.stringify(
        ledger.db
          .prepare('SELECT id, ts, asset, address, ip, api_key_id, amount_micro, status, tx_hash, error FROM mainnet_ledger ORDER BY id DESC LIMIT ?')
          .all(limit),
        null,
        2,
      )
    }
    if (group === 'summary') {
      const out: Record<string, unknown> = { monthStartUnix: monthStartUnix(now) }
      for (const a of ASSETS) {
        out[a] = {
          monthToDate: fromMicro(ledger.sumOutflow({ asset: a, sinceUnix: monthStartUnix(now) - 1 })),
          last24h: fromMicro(ledger.sumOutflow({ asset: a, sinceUnix: now - 86_400 })),
          dripsThisMonth: ledger.countedDrips(a, monthStartUnix(now) - 1),
        }
      }
      out.activeBlocks = ledger.activeBlockCounts(now)
      out.counters = ledger.counters()
      return JSON.stringify(out, null, 2)
    }
    return 'usage: key create|list|revoke|enable, block list|add|remove, ledger, summary (see src/mainnet/admin.ts)'
  } finally {
    ledger.close()
  }
}

const invokedDirectly = process.argv[1] && /mainnet[\\/]admin\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  // eslint-disable-next-line no-console
  console.log(runAdmin(process.argv.slice(2)))
}
