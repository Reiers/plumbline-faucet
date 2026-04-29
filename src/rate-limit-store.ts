// SPDX-License-Identifier: MIT
//
// Persistent rate-limit store backed by SQLite. Per-asset, per-IP and
// per-address windows; each window allows N drips before rate-limit
// kicks in. The window opens with the first drip and stays open until
// `window_seconds` have elapsed since `window_start_unix`.
//
// Schema:
//   ip_drips      (ip TEXT, asset TEXT, window_start_unix INTEGER,
//                  count INTEGER, PK(ip, asset))
//   address_drips (address TEXT, asset TEXT, window_start_unix INTEGER,
//                  count INTEGER, PK(address, asset))
//
// Migration paths handled automatically on construction:
//   v1 → v2 (no `asset` column → composite PK with asset='fil')
//   v2 → v3 (last_drip_unix only → window_start_unix + count)

import Database from 'better-sqlite3'

export type Asset = 'fil' | 'usdfc'

export interface WindowState {
  /** unix seconds at which the current window started (oldest drip in window) */
  windowStartUnix: number
  /** number of drips already counted inside the current window */
  count: number
}

export class RateLimitStore {
  readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    const cols = (tbl: string) =>
      (this.db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string }[]).map((r) => r.name)

    const ipCols = cols('ip_drips')
    const addrCols = cols('address_drips')

    const isV1Ip = ipCols.includes('last_drip_unix') && !ipCols.includes('asset')
    const isV1Addr = addrCols.includes('last_drip_unix') && !addrCols.includes('asset')
    const isV2Ip = ipCols.includes('asset') && ipCols.includes('last_drip_unix') && !ipCols.includes('count')
    const isV2Addr = addrCols.includes('asset') && addrCols.includes('last_drip_unix') && !addrCols.includes('count')

    if (isV1Ip || isV1Addr || isV2Ip || isV2Addr) {
      const tx = this.db.transaction(() => {
        if (ipCols.length) this.db.exec(`ALTER TABLE ip_drips RENAME TO ip_drips_old`)
        if (addrCols.length) this.db.exec(`ALTER TABLE address_drips RENAME TO address_drips_old`)

        this.createV3Tables()

        if (isV1Ip) {
          this.db.exec(`
            INSERT OR IGNORE INTO ip_drips (ip, asset, window_start_unix, count)
            SELECT ip, 'fil', last_drip_unix, 1 FROM ip_drips_old;
          `)
        } else if (isV2Ip) {
          this.db.exec(`
            INSERT OR IGNORE INTO ip_drips (ip, asset, window_start_unix, count)
            SELECT ip, asset, last_drip_unix, 1 FROM ip_drips_old;
          `)
        }
        if (ipCols.length) this.db.exec(`DROP TABLE ip_drips_old`)

        if (isV1Addr) {
          this.db.exec(`
            INSERT OR IGNORE INTO address_drips (address, asset, window_start_unix, count)
            SELECT address, 'fil', last_drip_unix, 1 FROM address_drips_old;
          `)
        } else if (isV2Addr) {
          this.db.exec(`
            INSERT OR IGNORE INTO address_drips (address, asset, window_start_unix, count)
            SELECT address, asset, last_drip_unix, 1 FROM address_drips_old;
          `)
        }
        if (addrCols.length) this.db.exec(`DROP TABLE address_drips_old`)
      })
      tx()
    } else {
      this.createV3Tables()
    }
  }

  private createV3Tables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_drips (
        ip TEXT NOT NULL,
        asset TEXT NOT NULL,
        window_start_unix INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (ip, asset)
      );
      CREATE TABLE IF NOT EXISTS address_drips (
        address TEXT NOT NULL,
        asset TEXT NOT NULL,
        window_start_unix INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (address, asset)
      );
    `)
  }

  windowForIp(ip: string, asset: Asset): WindowState | null {
    const row = this.db
      .prepare('SELECT window_start_unix, count FROM ip_drips WHERE ip = ? AND asset = ?')
      .get(ip, asset) as { window_start_unix: number; count: number } | undefined
    return row ? { windowStartUnix: row.window_start_unix, count: row.count } : null
  }

  windowForAddress(address: string, asset: Asset): WindowState | null {
    const lower = address.toLowerCase()
    const row = this.db
      .prepare('SELECT window_start_unix, count FROM address_drips WHERE address = ? AND asset = ?')
      .get(lower, asset) as { window_start_unix: number; count: number } | undefined
    return row ? { windowStartUnix: row.window_start_unix, count: row.count } : null
  }

  /**
   * Record a successful drip. If the existing window has expired, start a
   * new one with count=1. If the window is still open, bump count by 1.
   */
  recordDrip(ip: string, address: string, asset: Asset, now: number, windowSeconds: number): void {
    const lower = address.toLowerCase()
    const tx = this.db.transaction(() => {
      const ipRow = this.windowForIp(ip, asset)
      const ipFresh = !ipRow || now - ipRow.windowStartUnix > windowSeconds
      this.db
        .prepare(`
          INSERT INTO ip_drips (ip, asset, window_start_unix, count) VALUES (?, ?, ?, 1)
          ON CONFLICT(ip, asset) DO UPDATE SET
            window_start_unix = CASE WHEN ? THEN excluded.window_start_unix ELSE ip_drips.window_start_unix END,
            count             = CASE WHEN ? THEN 1 ELSE ip_drips.count + 1 END
        `)
        .run(ip, asset, now, ipFresh ? 1 : 0, ipFresh ? 1 : 0)

      const addrRow = this.windowForAddress(address, asset)
      const addrFresh = !addrRow || now - addrRow.windowStartUnix > windowSeconds
      this.db
        .prepare(`
          INSERT INTO address_drips (address, asset, window_start_unix, count) VALUES (?, ?, ?, 1)
          ON CONFLICT(address, asset) DO UPDATE SET
            window_start_unix = CASE WHEN ? THEN excluded.window_start_unix ELSE address_drips.window_start_unix END,
            count             = CASE WHEN ? THEN 1 ELSE address_drips.count + 1 END
        `)
        .run(lower, asset, now, addrFresh ? 1 : 0, addrFresh ? 1 : 0)
    })
    tx()
  }

  close(): void {
    this.db.close()
  }
}
