// SPDX-License-Identifier: MIT
//
// Aggregate stats + recent-drip feed, persisted alongside rate limits.
// Per-asset stats so the status page can show separate counters for
// tFIL and USDFC.
//
// Schema:
//   stats (name TEXT PK, value TEXT)
//     - total_drips_count_fil    u64
//     - total_drips_count_usdfc  u64
//     - total_fil_distributed    bigint string (wei)
//     - total_usdfc_distributed  bigint string (wei)
//   recent_drips (unix INTEGER, address TEXT, asset TEXT, tx TEXT)
//     bounded to the last 50 rows; pruned on insert.
//
// IPs are deliberately NOT stored in recent_drips; the public
// /api/recent endpoint exposes rows verbatim and per-IP attribution
// would leak.

import type Database from 'better-sqlite3'

export type Asset = 'fil' | 'usdfc'

export interface Stats {
  totalDripsFil: number
  totalDripsUsdfc: number
  totalFilWei: string
  totalUsdfcWei: string
  filDripsToday: number
  usdfcDripsToday: number
}

export interface RecentDrip {
  unix: number
  address: string
  asset: Asset
  tx: string
}

export class StatsStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stats (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_drips (
        unix INTEGER NOT NULL,
        address TEXT NOT NULL,
        asset TEXT NOT NULL,
        tx TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recent_drips_unix_idx ON recent_drips(unix DESC);
    `)
    this.migrateLegacyRecentDrips()
  }

  // v1 stored a single recent_drips row per drip with separate fil_tx and
  // usdfc_tx columns. v2 splits them into two rows tagged by asset.
  private migrateLegacyRecentDrips(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(recent_drips)`)
      .all() as { name: string }[]
    const hasLegacy = cols.some((c) => c.name === 'fil_tx') && cols.some((c) => c.name === 'usdfc_tx')
    if (!hasLegacy) return
    const tx = this.db.transaction(() => {
      // Drop the old index first; renaming the table would otherwise leave
      // it attached to recent_drips_v1, blocking us from re-creating the
      // same name on the new table below.
      this.db.exec(`DROP INDEX IF EXISTS recent_drips_unix_idx`)
      this.db.exec(`ALTER TABLE recent_drips RENAME TO recent_drips_v1`)
      this.db.exec(`
        CREATE TABLE recent_drips (
          unix INTEGER NOT NULL,
          address TEXT NOT NULL,
          asset TEXT NOT NULL,
          tx TEXT NOT NULL
        );
        CREATE INDEX recent_drips_unix_idx ON recent_drips(unix DESC);
        INSERT INTO recent_drips (unix, address, asset, tx)
          SELECT unix, address, 'fil',   fil_tx   FROM recent_drips_v1
          UNION ALL
          SELECT unix, address, 'usdfc', usdfc_tx FROM recent_drips_v1;
        DROP TABLE recent_drips_v1;
      `)
    })
    tx()
  }

  recordDrip(
    unix: number,
    address: string,
    asset: Asset,
    tx: string,
    weiAmount: bigint,
  ): void {
    const txn = this.db.transaction(() => {
      const countKey = asset === 'fil' ? 'total_drips_count_fil' : 'total_drips_count_usdfc'
      const totalKey = asset === 'fil' ? 'total_fil_distributed' : 'total_usdfc_distributed'

      this.db
        .prepare(`
          INSERT INTO stats (name, value) VALUES (?, '1')
          ON CONFLICT(name) DO UPDATE SET
            value = CAST((CAST(value AS INTEGER) + 1) AS TEXT)
        `)
        .run(countKey)

      const cur = this.db
        .prepare('SELECT value FROM stats WHERE name = ?')
        .get(totalKey) as { value: string } | undefined
      const next = (cur ? BigInt(cur.value) : 0n) + weiAmount
      this.db
        .prepare(`
          INSERT INTO stats (name, value) VALUES (?, ?)
          ON CONFLICT(name) DO UPDATE SET value = excluded.value
        `)
        .run(totalKey, next.toString())

      this.db
        .prepare('INSERT INTO recent_drips (unix, address, asset, tx) VALUES (?, ?, ?, ?)')
        .run(unix, address.toLowerCase(), asset, tx)

      this.db.exec(`
        DELETE FROM recent_drips
        WHERE rowid NOT IN (
          SELECT rowid FROM recent_drips ORDER BY unix DESC LIMIT 50
        )
      `)
    })
    txn()
  }

  read(): Stats {
    const get = (k: string, fallback: string): string => {
      const row = this.db
        .prepare('SELECT value FROM stats WHERE name = ?')
        .get(k) as { value: string } | undefined
      return row?.value ?? fallback
    }
    const dayAgo = Math.floor(Date.now() / 1000) - 86400
    const filToday = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM recent_drips WHERE unix >= ? AND asset = 'fil'")
        .get(dayAgo) as { n: number }
    ).n
    const usdfcToday = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM recent_drips WHERE unix >= ? AND asset = 'usdfc'")
        .get(dayAgo) as { n: number }
    ).n
    return {
      totalDripsFil: Number(get('total_drips_count_fil', '0')),
      totalDripsUsdfc: Number(get('total_drips_count_usdfc', '0')),
      totalFilWei: get('total_fil_distributed', '0'),
      totalUsdfcWei: get('total_usdfc_distributed', '0'),
      filDripsToday: filToday,
      usdfcDripsToday: usdfcToday,
    }
  }

  recent(limit = 10): RecentDrip[] {
    return this.db
      .prepare(
        'SELECT unix, address, asset, tx FROM recent_drips ORDER BY unix DESC LIMIT ?',
      )
      .all(limit) as RecentDrip[]
  }
}
