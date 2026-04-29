// SPDX-License-Identifier: MIT
//
// Aggregate stats + recent-drip feed, persisted in the same SQLite
// database that backs rate limiting.
//
// Schema:
//   stats(name TEXT PK, value TEXT)
//     - total_drips_count        u64
//     - total_fil_distributed    string (parseable as bigint, wei)
//     - total_usdfc_distributed  string (parseable as bigint, wei)
//   recent_drips(unix INTEGER, address TEXT, fil_tx TEXT, usdfc_tx TEXT)
//     bounded to the last 50 rows; older entries are pruned on insert.
//
// We deliberately do NOT persist IPs in this table; the public
// /api/recent endpoint exposes recent rows verbatim and we don't want
// to leak per-IP attribution.

import type Database from 'better-sqlite3'

export interface Stats {
  totalDrips: number
  totalFilWei: string
  totalUsdfcWei: string
  dripsToday: number
}

export interface RecentDrip {
  unix: number
  address: string
  filTx: string
  usdfcTx: string
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
        fil_tx TEXT NOT NULL,
        usdfc_tx TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recent_drips_unix_idx ON recent_drips(unix DESC);
    `)
  }

  recordDrip(
    unix: number,
    address: string,
    filTx: string,
    usdfcTx: string,
    filWei: bigint,
    usdfcWei: bigint,
  ): void {
    const tx = this.db.transaction(() => {
      // Bump counters
      const bumpInt = this.db.prepare(`
        INSERT INTO stats (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET
          value = CAST((CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER)) AS TEXT)
      `)
      const bumpBig = this.db.prepare(`
        INSERT INTO stats (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET value = ?
      `)
      // For bigints, read-modify-write because SQLite int math is 64-bit and
      // wei can overflow.
      const readBig = (k: string): bigint => {
        const row = this.db
          .prepare('SELECT value FROM stats WHERE name = ?')
          .get(k) as { value: string } | undefined
        return row ? BigInt(row.value) : 0n
      }

      bumpInt.run('total_drips_count', '1')
      const newFil = readBig('total_fil_distributed') + filWei
      bumpBig.run('total_fil_distributed', newFil.toString(), newFil.toString())
      const newUsdfc = readBig('total_usdfc_distributed') + usdfcWei
      bumpBig.run(
        'total_usdfc_distributed',
        newUsdfc.toString(),
        newUsdfc.toString(),
      )

      this.db
        .prepare(
          'INSERT INTO recent_drips (unix, address, fil_tx, usdfc_tx) VALUES (?, ?, ?, ?)',
        )
        .run(unix, address.toLowerCase(), filTx, usdfcTx)

      // Cap to the most recent 50.
      this.db.exec(`
        DELETE FROM recent_drips
        WHERE rowid NOT IN (
          SELECT rowid FROM recent_drips ORDER BY unix DESC LIMIT 50
        )
      `)
    })
    tx()
  }

  read(): Stats {
    const get = (k: string, fallback: string): string => {
      const row = this.db
        .prepare('SELECT value FROM stats WHERE name = ?')
        .get(k) as { value: string } | undefined
      return row?.value ?? fallback
    }
    const dayAgo = Math.floor(Date.now() / 1000) - 86400
    const dripsToday = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM recent_drips WHERE unix >= ?')
        .get(dayAgo) as { n: number }
    ).n
    return {
      totalDrips: Number(get('total_drips_count', '0')),
      totalFilWei: get('total_fil_distributed', '0'),
      totalUsdfcWei: get('total_usdfc_distributed', '0'),
      dripsToday,
    }
  }

  recent(limit = 10): RecentDrip[] {
    const rows = this.db
      .prepare(
        'SELECT unix, address, fil_tx AS filTx, usdfc_tx AS usdfcTx FROM recent_drips ORDER BY unix DESC LIMIT ?',
      )
      .all(limit) as RecentDrip[]
    return rows
  }
}
