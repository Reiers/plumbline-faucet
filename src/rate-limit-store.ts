// SPDX-License-Identifier: MIT
//
// Persistent rate-limit store backed by SQLite. Keeps two tables:
//
//   ip_drips      (ip TEXT PK, last_drip_unix INTEGER)
//   address_drips (address TEXT PK, last_drip_unix INTEGER)
//
// Both tables track only the most recent successful drip; older entries
// are overwritten in-place on each drip so the DB stays small.
//
// The store does NOT count attempts; only successful drips. A failed
// drip (e.g. faucet dry, captcha rejected) never updates the store.
//
// Aggregate counters and the recent-drips feed live in stats-store.ts,
// which shares the same Database connection.

import Database from 'better-sqlite3'

export class RateLimitStore {
  readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_drips (
        ip TEXT PRIMARY KEY,
        last_drip_unix INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS address_drips (
        address TEXT PRIMARY KEY,
        last_drip_unix INTEGER NOT NULL
      );
    `)
  }

  lastDripForIp(ip: string): number | null {
    const row = this.db
      .prepare('SELECT last_drip_unix FROM ip_drips WHERE ip = ?')
      .get(ip) as { last_drip_unix: number } | undefined
    return row?.last_drip_unix ?? null
  }

  lastDripForAddress(address: string): number | null {
    const lower = address.toLowerCase()
    const row = this.db
      .prepare('SELECT last_drip_unix FROM address_drips WHERE address = ?')
      .get(lower) as { last_drip_unix: number } | undefined
    return row?.last_drip_unix ?? null
  }

  recordDrip(ip: string, address: string, unix: number): void {
    const lower = address.toLowerCase()
    const upsertIp = this.db.prepare(`
      INSERT INTO ip_drips (ip, last_drip_unix) VALUES (?, ?)
      ON CONFLICT(ip) DO UPDATE SET last_drip_unix = excluded.last_drip_unix
    `)
    const upsertAddr = this.db.prepare(`
      INSERT INTO address_drips (address, last_drip_unix) VALUES (?, ?)
      ON CONFLICT(address) DO UPDATE SET last_drip_unix = excluded.last_drip_unix
    `)
    const tx = this.db.transaction(() => {
      upsertIp.run(ip, unix)
      upsertAddr.run(lower, unix)
    })
    tx()
  }

  close(): void {
    this.db.close()
  }
}
