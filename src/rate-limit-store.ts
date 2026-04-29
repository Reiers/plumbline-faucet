// SPDX-License-Identifier: MIT
//
// Persistent rate-limit store backed by SQLite. Per-asset limits so a
// user can drip both rails inside one cooldown window without blocking
// the other.
//
// Schema:
//   ip_drips      (ip TEXT, asset TEXT, last_drip_unix INTEGER, PK(ip,asset))
//   address_drips (address TEXT, asset TEXT, last_drip_unix INTEGER, PK(address,asset))
//
// Migration from the v1 single-asset schema is automatic: if the old
// non-composite tables exist, we copy their rows into the new tables
// tagged with asset='fil' (the v1 default), then drop the old tables.

import Database from 'better-sqlite3'

export type Asset = 'fil' | 'usdfc'

export class RateLimitStore {
  readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    // Detect v1 schema (no `asset` column).
    const hasV1Ip = this.tableHasColumn('ip_drips', 'last_drip_unix') &&
      !this.tableHasColumn('ip_drips', 'asset')
    const hasV1Addr = this.tableHasColumn('address_drips', 'last_drip_unix') &&
      !this.tableHasColumn('address_drips', 'asset')

    if (hasV1Ip || hasV1Addr) {
      const tx = this.db.transaction(() => {
        if (hasV1Ip) {
          this.db.exec(`ALTER TABLE ip_drips RENAME TO ip_drips_v1`)
        }
        if (hasV1Addr) {
          this.db.exec(`ALTER TABLE address_drips RENAME TO address_drips_v1`)
        }
        this.createV2Tables()
        if (hasV1Ip) {
          this.db.exec(`
            INSERT OR IGNORE INTO ip_drips (ip, asset, last_drip_unix)
            SELECT ip, 'fil', last_drip_unix FROM ip_drips_v1;
            DROP TABLE ip_drips_v1;
          `)
        }
        if (hasV1Addr) {
          this.db.exec(`
            INSERT OR IGNORE INTO address_drips (address, asset, last_drip_unix)
            SELECT address, 'fil', last_drip_unix FROM address_drips_v1;
            DROP TABLE address_drips_v1;
          `)
        }
      })
      tx()
    } else {
      this.createV2Tables()
    }
  }

  private createV2Tables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_drips (
        ip TEXT NOT NULL,
        asset TEXT NOT NULL,
        last_drip_unix INTEGER NOT NULL,
        PRIMARY KEY (ip, asset)
      );
      CREATE TABLE IF NOT EXISTS address_drips (
        address TEXT NOT NULL,
        asset TEXT NOT NULL,
        last_drip_unix INTEGER NOT NULL,
        PRIMARY KEY (address, asset)
      );
    `)
  }

  private tableHasColumn(tbl: string, col: string): boolean {
    const rows = this.db
      .prepare(`PRAGMA table_info(${tbl})`)
      .all() as { name: string }[]
    return rows.some((r) => r.name === col)
  }

  lastDripForIp(ip: string, asset: Asset): number | null {
    const row = this.db
      .prepare('SELECT last_drip_unix FROM ip_drips WHERE ip = ? AND asset = ?')
      .get(ip, asset) as { last_drip_unix: number } | undefined
    return row?.last_drip_unix ?? null
  }

  lastDripForAddress(address: string, asset: Asset): number | null {
    const lower = address.toLowerCase()
    const row = this.db
      .prepare('SELECT last_drip_unix FROM address_drips WHERE address = ? AND asset = ?')
      .get(lower, asset) as { last_drip_unix: number } | undefined
    return row?.last_drip_unix ?? null
  }

  recordDrip(ip: string, address: string, asset: Asset, unix: number): void {
    const lower = address.toLowerCase()
    const upsertIp = this.db.prepare(`
      INSERT INTO ip_drips (ip, asset, last_drip_unix) VALUES (?, ?, ?)
      ON CONFLICT(ip, asset) DO UPDATE SET last_drip_unix = excluded.last_drip_unix
    `)
    const upsertAddr = this.db.prepare(`
      INSERT INTO address_drips (address, asset, last_drip_unix) VALUES (?, ?, ?)
      ON CONFLICT(address, asset) DO UPDATE SET last_drip_unix = excluded.last_drip_unix
    `)
    const tx = this.db.transaction(() => {
      upsertIp.run(ip, asset, unix)
      upsertAddr.run(lower, asset, unix)
    })
    tx()
  }

  close(): void {
    this.db.close()
  }
}
