// SPDX-License-Identifier: MIT
//
// Mainnet preview persistence (SQLite, separate file from calibration).
//
// Tables:
//   mainnet_ledger    one row per drip attempt that reached the send
//                     step. Amount stored in micro-units (1e-6) so every
//                     cap is an exact integer sum. Rows in status
//                     pending/sent/confirmed count against caps (plus
//                     simulated rows in dry-run mode). failed/reverted
//                     rows do not count.
//   mainnet_events    every drip request (accepted or refused), used by
//                     abuse detection and audit. Pruned after 90 days.
//   mainnet_blocks    active and expired blocks (ip, subnet, address).
//   mainnet_api_keys  integrator keys. Only the SHA-256 hash is stored.
//   mainnet_counters  monotonic counters for /metrics.

import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import type { MainnetAsset } from './config.js'

export type LedgerStatus = 'pending' | 'sent' | 'confirmed' | 'failed' | 'reverted' | 'simulated'
export type BlockKind = 'ip' | 'subnet' | 'address'
export type EventOutcome = 'attempt' | 'ok' | 'refused' | 'error'

export interface EventRow {
  ts: number
  ip: string
  subnet: string
  address: string | null
  asset: MainnetAsset | null
  outcome: EventOutcome
  reason: string | null
  /** 1 when the request passed captcha or API key auth. */
  verified: boolean
  apiKeyId: number | null
}

export interface Block {
  kind: BlockKind
  value: string
  reason: string
  createdUnix: number
  untilUnix: number
  source: 'auto' | 'manual'
}

export interface MainnetApiKey {
  id: number
  name: string
  enabled: boolean
  createdUnix: number
  capUsdfcMicro: bigint
  capFilMicro: bigint
  windowSec: number
  notes: string | null
}

export interface OutflowFilter {
  asset: MainnetAsset
  sinceUnix: number
  address?: string
  ip?: string
  subnet?: string
  /** number = that key only, null = anonymous traffic only, undefined = all. */
  apiKeyId?: number | null
}

export const hashApiKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex')

/** Unix seconds of the first instant of the UTC calendar month containing now. */
export function monthStartUnix(nowUnix: number): number {
  const d = new Date(nowUnix * 1000)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
}
export function nextMonthStartUnix(nowUnix: number): number {
  const d = new Date(nowUnix * 1000)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000)
}

export class MainnetLedger {
  readonly db: Database.Database
  private counted: LedgerStatus[]

  constructor(path: string, opts: { countSimulated: boolean }) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.counted = opts.countSimulated ? ['pending', 'sent', 'confirmed', 'simulated'] : ['pending', 'sent', 'confirmed']
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mainnet_ledger (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        asset         TEXT    NOT NULL,
        address       TEXT    NOT NULL,
        ip            TEXT    NOT NULL,
        subnet        TEXT    NOT NULL,
        api_key_id    INTEGER,
        amount_micro  INTEGER NOT NULL,
        status        TEXT    NOT NULL,
        tx_hash       TEXT,
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS ml_asset_ts      ON mainnet_ledger(asset, ts);
      CREATE INDEX IF NOT EXISTS ml_asset_addr_ts ON mainnet_ledger(asset, address, ts);
      CREATE INDEX IF NOT EXISTS ml_asset_ip_ts   ON mainnet_ledger(asset, ip, ts);
      CREATE INDEX IF NOT EXISTS ml_asset_sub_ts  ON mainnet_ledger(asset, subnet, ts);
      CREATE INDEX IF NOT EXISTS ml_key_ts        ON mainnet_ledger(api_key_id, asset, ts);

      CREATE TABLE IF NOT EXISTS mainnet_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        ip          TEXT    NOT NULL,
        subnet      TEXT    NOT NULL,
        address     TEXT,
        asset       TEXT,
        outcome     TEXT    NOT NULL,
        reason      TEXT,
        verified    INTEGER NOT NULL DEFAULT 0,
        api_key_id  INTEGER
      );
      CREATE INDEX IF NOT EXISTS me_ip_ts     ON mainnet_events(ip, ts);
      CREATE INDEX IF NOT EXISTS me_subnet_ts ON mainnet_events(subnet, ts);
      CREATE INDEX IF NOT EXISTS me_addr_ts   ON mainnet_events(address, ts);

      CREATE TABLE IF NOT EXISTS mainnet_blocks (
        kind         TEXT    NOT NULL,
        value        TEXT    NOT NULL,
        reason       TEXT    NOT NULL,
        created_unix INTEGER NOT NULL,
        until_unix   INTEGER NOT NULL,
        source       TEXT    NOT NULL,
        PRIMARY KEY (kind, value)
      );

      CREATE TABLE IF NOT EXISTS mainnet_api_keys (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT    NOT NULL UNIQUE,
        key_hash         TEXT    NOT NULL UNIQUE,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_unix     INTEGER NOT NULL,
        cap_usdfc_micro  INTEGER NOT NULL,
        cap_fil_micro    INTEGER NOT NULL,
        window_sec       INTEGER NOT NULL,
        notes            TEXT
      );

      CREATE TABLE IF NOT EXISTS mainnet_counters (
        name   TEXT PRIMARY KEY,
        value  INTEGER NOT NULL
      );
    `)
  }

  // ─── Outflow ledger ─────────────────────────────────────────────

  sumOutflow(f: OutflowFilter): bigint {
    const where: string[] = ['asset = ?', 'ts > ?']
    const args: (string | number)[] = [f.asset, f.sinceUnix]
    if (f.address !== undefined) { where.push('address = ?'); args.push(f.address.toLowerCase()) }
    if (f.ip !== undefined) { where.push('ip = ?'); args.push(f.ip) }
    if (f.subnet !== undefined) { where.push('subnet = ?'); args.push(f.subnet) }
    if (f.apiKeyId === null) where.push('api_key_id IS NULL')
    else if (f.apiKeyId !== undefined) { where.push('api_key_id = ?'); args.push(f.apiKeyId) }
    where.push(`status IN (${this.counted.map(() => '?').join(',')})`)
    args.push(...this.counted)
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_micro), 0) AS n FROM mainnet_ledger WHERE ${where.join(' AND ')}`)
      .get(...args) as { n: number | bigint }
    return BigInt(row.n)
  }

  /** Oldest counted row in a window (used to compute retry-after). */
  oldestInWindow(f: OutflowFilter): number | null {
    const where: string[] = ['asset = ?', 'ts > ?']
    const args: (string | number)[] = [f.asset, f.sinceUnix]
    if (f.address !== undefined) { where.push('address = ?'); args.push(f.address.toLowerCase()) }
    if (f.ip !== undefined) { where.push('ip = ?'); args.push(f.ip) }
    if (f.subnet !== undefined) { where.push('subnet = ?'); args.push(f.subnet) }
    if (f.apiKeyId === null) where.push('api_key_id IS NULL')
    else if (f.apiKeyId !== undefined) { where.push('api_key_id = ?'); args.push(f.apiKeyId) }
    where.push(`status IN (${this.counted.map(() => '?').join(',')})`)
    args.push(...this.counted)
    const row = this.db
      .prepare(`SELECT MIN(ts) AS t FROM mainnet_ledger WHERE ${where.join(' AND ')}`)
      .get(...args) as { t: number | null }
    return row.t ?? null
  }

  insertPending(r: {
    ts: number
    asset: MainnetAsset
    address: string
    ip: string
    subnet: string
    apiKeyId: number | null
    amountMicro: bigint
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO mainnet_ledger (ts, asset, address, ip, subnet, api_key_id, amount_micro, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(r.ts, r.asset, r.address.toLowerCase(), r.ip, r.subnet, r.apiKeyId, r.amountMicro)
    return Number(info.lastInsertRowid)
  }

  setStatus(id: number, status: LedgerStatus, extra: { txHash?: string | null; error?: string | null } = {}): void {
    this.db
      .prepare(
        `UPDATE mainnet_ledger
         SET status = ?, tx_hash = COALESCE(?, tx_hash), error = COALESCE(?, error)
         WHERE id = ?`,
      )
      .run(status, extra.txHash ?? null, extra.error ?? null, id)
  }

  /** Broadcast (or about to be) but not confirmed yet, last 24h. */
  inflightMicro(asset: MainnetAsset, nowUnix: number): bigint {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_micro), 0) AS n FROM mainnet_ledger
         WHERE asset = ? AND status IN ('pending', 'sent') AND ts > ?`,
      )
      .get(asset, nowUnix - 86_400) as { n: number | bigint }
    return BigInt(row.n)
  }

  countByStatus(asset: MainnetAsset, status: LedgerStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM mainnet_ledger WHERE asset = ? AND status = ?')
      .get(asset, status) as { n: number }
    return row.n
  }

  countedDrips(asset: MainnetAsset, sinceUnix = 0): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM mainnet_ledger
         WHERE asset = ? AND ts > ? AND status IN (${this.counted.map(() => '?').join(',')})`,
      )
      .get(asset, sinceUnix, ...this.counted) as { n: number }
    return row.n
  }

  recent(limit: number): Array<{ ts: number; asset: string; address: string; amountMicro: bigint; status: string; txHash: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT ts, asset, address, amount_micro, status, tx_hash FROM mainnet_ledger
         WHERE status IN ('sent','confirmed','simulated')
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{ ts: number; asset: string; address: string; amount_micro: number; status: string; tx_hash: string | null }>
    return rows.map((r) => ({
      ts: r.ts,
      asset: r.asset,
      address: r.address,
      amountMicro: BigInt(r.amount_micro),
      status: r.status,
      txHash: r.tx_hash,
    }))
  }

  // ─── Events (abuse detection input) ─────────────────────────────

  recordEvent(e: EventRow): number {
    const info = this.db
      .prepare(
        `INSERT INTO mainnet_events (ts, ip, subnet, address, asset, outcome, reason, verified, api_key_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.ts, e.ip, e.subnet, e.address?.toLowerCase() ?? null, e.asset, e.outcome, e.reason, e.verified ? 1 : 0, e.apiKeyId)
    return Number(info.lastInsertRowid)
  }

  updateEvent(id: number, u: { outcome?: EventOutcome; reason?: string | null; verified?: boolean }): void {
    this.db
      .prepare(
        `UPDATE mainnet_events SET
           outcome  = COALESCE(?, outcome),
           reason   = COALESCE(?, reason),
           verified = COALESCE(?, verified)
         WHERE id = ?`,
      )
      .run(u.outcome ?? null, u.reason ?? null, u.verified === undefined ? null : u.verified ? 1 : 0, id)
  }

  /** Anonymous (non API key) events only. */
  countEvents(f: { sinceUnix: number; ip?: string; subnet?: string; reason?: string }): number {
    const where = ['ts > ?', 'api_key_id IS NULL']
    const args: (string | number)[] = [f.sinceUnix]
    if (f.ip !== undefined) { where.push('ip = ?'); args.push(f.ip) }
    if (f.subnet !== undefined) { where.push('subnet = ?'); args.push(f.subnet) }
    if (f.reason !== undefined) { where.push('reason = ?'); args.push(f.reason) }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM mainnet_events WHERE ${where.join(' AND ')}`)
      .get(...args) as { n: number }
    return row.n
  }

  /** Distinct recipient addresses seen from an IP or subnet (anonymous events only). */
  distinctAddresses(f: { sinceUnix: number; ip?: string; subnet?: string }): number {
    const where = ['ts > ?', 'address IS NOT NULL', 'api_key_id IS NULL']
    const args: (string | number)[] = [f.sinceUnix]
    if (f.ip !== undefined) { where.push('ip = ?'); args.push(f.ip) }
    if (f.subnet !== undefined) { where.push('subnet = ?'); args.push(f.subnet) }
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT address) AS n FROM mainnet_events WHERE ${where.join(' AND ')}`)
      .get(...args) as { n: number }
    return row.n
  }

  /** Distinct client IPs that made verified requests for an address. */
  distinctVerifiedIps(address: string, sinceUnix: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT ip) AS n FROM mainnet_events
         WHERE address = ? AND ts > ? AND verified = 1 AND api_key_id IS NULL`,
      )
      .get(address.toLowerCase(), sinceUnix) as { n: number }
    return row.n
  }

  // ─── Blocks ─────────────────────────────────────────────────────

  activeBlock(kind: BlockKind, value: string, nowUnix: number): Block | null {
    const row = this.db
      .prepare(`SELECT * FROM mainnet_blocks WHERE kind = ? AND value = ? AND until_unix > ?`)
      .get(kind, kind === 'address' ? value.toLowerCase() : value, nowUnix) as
      | { kind: BlockKind; value: string; reason: string; created_unix: number; until_unix: number; source: 'auto' | 'manual' }
      | undefined
    return row
      ? { kind: row.kind, value: row.value, reason: row.reason, createdUnix: row.created_unix, untilUnix: row.until_unix, source: row.source }
      : null
  }

  addBlock(b: Block): void {
    this.db
      .prepare(
        `INSERT INTO mainnet_blocks (kind, value, reason, created_unix, until_unix, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, value) DO UPDATE SET
           reason = excluded.reason, created_unix = excluded.created_unix,
           until_unix = MAX(mainnet_blocks.until_unix, excluded.until_unix), source = excluded.source`,
      )
      .run(b.kind, b.kind === 'address' ? b.value.toLowerCase() : b.value, b.reason, b.createdUnix, b.untilUnix, b.source)
  }

  removeBlock(kind: BlockKind, value: string): boolean {
    const info = this.db
      .prepare('DELETE FROM mainnet_blocks WHERE kind = ? AND value = ?')
      .run(kind, kind === 'address' ? value.toLowerCase() : value)
    return info.changes > 0
  }

  listBlocks(nowUnix: number): Block[] {
    const rows = this.db
      .prepare('SELECT * FROM mainnet_blocks WHERE until_unix > ? ORDER BY created_unix DESC')
      .all(nowUnix) as Array<{ kind: BlockKind; value: string; reason: string; created_unix: number; until_unix: number; source: 'auto' | 'manual' }>
    return rows.map((r) => ({ kind: r.kind, value: r.value, reason: r.reason, createdUnix: r.created_unix, untilUnix: r.until_unix, source: r.source }))
  }

  activeBlockCounts(nowUnix: number): Record<BlockKind, number> {
    const out: Record<BlockKind, number> = { ip: 0, subnet: 0, address: 0 }
    const rows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM mainnet_blocks WHERE until_unix > ? GROUP BY kind')
      .all(nowUnix) as Array<{ kind: BlockKind; n: number }>
    for (const r of rows) out[r.kind] = r.n
    return out
  }

  // ─── Counters ───────────────────────────────────────────────────

  inc(name: string, by = 1): void {
    this.db
      .prepare(`INSERT INTO mainnet_counters (name, value) VALUES (?, ?)
                ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`)
      .run(name, by)
  }

  counters(prefix = ''): Record<string, number> {
    const rows = this.db
      .prepare('SELECT name, value FROM mainnet_counters WHERE name LIKE ? ORDER BY name')
      .all(prefix + '%') as Array<{ name: string; value: number }>
    return Object.fromEntries(rows.map((r) => [r.name, r.value]))
  }

  // ─── API keys ───────────────────────────────────────────────────

  /** Create a key and return the plaintext once. Only the hash is stored. */
  createApiKey(input: { name: string; capUsdfcMicro: bigint; capFilMicro: bigint; windowSec: number; notes?: string | null; nowUnix: number }): string {
    const key = 'plmn_' + randomBytes(24).toString('base64url')
    this.db
      .prepare(
        `INSERT INTO mainnet_api_keys (name, key_hash, enabled, created_unix, cap_usdfc_micro, cap_fil_micro, window_sec, notes)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(input.name, hashApiKey(key), input.nowUnix, input.capUsdfcMicro, input.capFilMicro, input.windowSec, input.notes ?? null)
    return key
  }

  findApiKey(plain: string): MainnetApiKey | null {
    const row = this.db.prepare('SELECT * FROM mainnet_api_keys WHERE key_hash = ?').get(hashApiKey(plain)) as KeyRow | undefined
    return row ? toKey(row) : null
  }

  listApiKeys(): MainnetApiKey[] {
    return (this.db.prepare('SELECT * FROM mainnet_api_keys ORDER BY id').all() as KeyRow[]).map(toKey)
  }

  setApiKeyEnabled(name: string, enabled: boolean): boolean {
    return this.db.prepare('UPDATE mainnet_api_keys SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name).changes > 0
  }

  // ─── Housekeeping ───────────────────────────────────────────────

  prune(nowUnix: number, keepEventsSec = 90 * 86_400): void {
    this.db.prepare('DELETE FROM mainnet_events WHERE ts < ?').run(nowUnix - keepEventsSec)
    this.db.prepare('DELETE FROM mainnet_blocks WHERE until_unix < ?').run(nowUnix - 30 * 86_400)
  }

  close(): void {
    this.db.close()
  }
}

interface KeyRow {
  id: number
  name: string
  enabled: number
  created_unix: number
  cap_usdfc_micro: number
  cap_fil_micro: number
  window_sec: number
  notes: string | null
}
const toKey = (r: KeyRow): MainnetApiKey => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled === 1,
  createdUnix: r.created_unix,
  capUsdfcMicro: BigInt(r.cap_usdfc_micro),
  capFilMicro: BigInt(r.cap_fil_micro),
  windowSec: r.window_sec,
  notes: r.notes,
})
