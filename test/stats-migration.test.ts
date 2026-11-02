// SPDX-License-Identifier: MIT
//
// The production DB predates the amount_wei column. Opening it with the
// new StatsStore must add the column without touching existing rows, and
// the legacy /api/recent shape must stay the same.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { StatsStore } from '../src/stats-store.js'

test('StatsStore adds amount_wei to a pre-v1 recent_drips table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbline-mig-'))
  const file = path.join(dir, 'db.sqlite')
  const old = new Database(file)
  old.exec(`
    CREATE TABLE stats (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE recent_drips (unix INTEGER NOT NULL, address TEXT NOT NULL, asset TEXT NOT NULL, tx TEXT NOT NULL);
    CREATE INDEX recent_drips_unix_idx ON recent_drips(unix DESC);
    INSERT INTO recent_drips VALUES (100, '0xabc', 'fil', '0x01');
    INSERT INTO stats VALUES ('total_drips_count_fil', '7');
  `)
  old.close()

  const db = new Database(file)
  const s = new StatsStore(db)
  s.recordDrip(200, '0xDEF', 'usdfc', '0x02', 2000n * 10n ** 18n)
  const page = s.recentPage(10, 0)
  assert.equal(page.total, 2)
  assert.deepEqual(page.rows[0], { unix: 200, address: '0xdef', asset: 'usdfc', tx: '0x02', amountWei: (2000n * 10n ** 18n).toString() })
  assert.deepEqual(page.rows[1], { unix: 100, address: '0xabc', asset: 'fil', tx: '0x01', amountWei: null })
  assert.deepEqual(Object.keys(s.recent(1)[0]).sort(), ['address', 'asset', 'tx', 'unix'])
  assert.equal(s.read().totalDripsFil, 7)
  db.close()
  // idempotent on reopen
  const again = new StatsStore(new Database(file))
  assert.equal(again.recentPage(10, 0).total, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})
