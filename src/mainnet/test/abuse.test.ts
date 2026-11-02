// SPDX-License-Identifier: MIT
//
// Abuse detection: velocity signals, auto-block, block expiry, and the
// guarantee that third parties cannot get a victim address blocked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addr, harness } from './helpers.js'
import { runAdmin } from '../admin.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DAY = 86_400

test('ip_address_rotation: a 4th distinct address from one IP blocks the IP', async () => {
  const h = await harness({ MAINNET_IP_CAP_FIL: '1', MAINNET_SUBNET_CAP_FIL: '1' })
  const ip = '198.51.100.9'
  for (let i = 0; i < 3; i++) assert.equal((await h.drip('fil', addr(i), { ip })).status, 200)
  const r = await h.drip('fil', addr(3), { ip })
  assert.equal(r.status, 403)
  assert.equal(r.body.error, 'blocked')
  assert.equal(r.body.scope, 'ip')
  assert.equal(h.disp.sends.length, 3)
  // Still blocked with a fresh address and a valid captcha.
  assert.equal((await h.drip('usdfc', addr(9), { ip })).body.error, 'blocked')
  // Other IPs are fine.
  assert.equal((await h.drip('fil', addr(4), { ip: '203.0.113.4' })).status, 200)
  // Block shows up in metrics and the alert went to the operator sink only.
  const m = (await h.app.inject({ url: '/metrics' })).body
  assert.match(m, /plumbline_mainnet_active_blocks\{kind="ip"\} 1/)
  assert.match(m, /plumbline_mainnet_abuse_trips_total\{rule="ip_address_rotation"\} 1/)
  assert.match(m, /plumbline_mainnet_blocked_attempts_total 2/)
  assert.ok(h.alerts.some((a) => String(a.alert).startsWith('abuse_block:ip_address_rotation')))
  const status = (await h.app.inject({ url: '/api/status' })).body
  assert.ok(!status.includes(ip), 'public status must not leak client IPs')
  // Expires after MAINNET_ABUSE_BLOCK_SEC (24h default).
  h.clock.t += DAY + 1
  assert.equal((await h.drip('fil', addr(5), { ip })).status, 200)
})

test('ip_captcha_failures: more than 5 failed captchas per hour blocks the IP', async () => {
  const h = await harness()
  const ip = '198.51.100.66'
  for (let i = 0; i < 5; i++) assert.equal((await h.drip('usdfc', addr(1), { ip, token: 'bad' })).body.error, 'captcha')
  const sixth = await h.drip('usdfc', addr(1), { ip, token: 'bad' })
  assert.equal(sixth.body.error, 'captcha')
  const r = await h.drip('usdfc', addr(1), { ip })
  assert.equal(r.status, 403)
  assert.equal(r.body.scope, 'ip')
})

test('ip_velocity: attempts per hour over threshold blocks', async () => {
  const h = await harness({ MAINNET_ABUSE_IP_ATTEMPTS_PER_HOUR: '3' })
  const ip = '198.51.100.77'
  const a = addr(7)
  assert.equal((await h.drip('usdfc', a, { ip })).status, 200)
  assert.equal((await h.drip('usdfc', a, { ip })).body.error, 'address_cap')
  assert.equal((await h.drip('usdfc', a, { ip })).body.error, 'address_cap')
  const fourth = await h.drip('usdfc', a, { ip })
  assert.equal(fourth.status, 403)
  assert.equal(fourth.body.scope, 'ip')
})

test('subnet_address_rotation: many addresses from one /24 blocks the subnet', async () => {
  const h = await harness({ MAINNET_ABUSE_SUBNET_DISTINCT_ADDRESSES_PER_DAY: '2' })
  assert.equal((await h.drip('usdfc', addr(1), { ip: '192.0.2.1' })).status, 200)
  assert.equal((await h.drip('usdfc', addr(2), { ip: '192.0.2.2' })).status, 200)
  const r = await h.drip('usdfc', addr(3), { ip: '192.0.2.3' })
  assert.equal(r.status, 403)
  assert.equal(r.body.scope, 'subnet')
  assert.equal((await h.drip('usdfc', addr(4), { ip: '192.0.2.200' })).body.scope, 'subnet')
})

test('address_ip_rotation: one address requested from many verified IPs blocks the address', async () => {
  const h = await harness({ MAINNET_ABUSE_ADDRESS_DISTINCT_IPS_PER_DAY: '2' })
  const a = addr(50)
  assert.equal((await h.drip('usdfc', a, { ip: '198.51.100.1' })).status, 200)
  assert.equal((await h.drip('fil', a, { ip: '203.0.113.2' })).status, 200)
  const r = await h.drip('fil', a, { ip: '192.0.2.3' })
  assert.equal(r.status, 403)
  assert.equal(r.body.scope, 'address')
})

test('unverified requests cannot get a victim address blocked', async () => {
  const h = await harness({ MAINNET_ABUSE_ADDRESS_DISTINCT_IPS_PER_DAY: '2' })
  const victim = addr(60)
  for (let i = 0; i < 10; i++) {
    assert.equal((await h.drip('usdfc', victim, { ip: '203.0.' + i + '.9', token: 'bad' })).body.error, 'captcha')
  }
  assert.equal((await h.drip('usdfc', victim, { ip: '198.51.100.60' })).status, 200)
})

test('autoblock off: rules trip and are counted but nothing is blocked', async () => {
  const h = await harness({ MAINNET_ABUSE_AUTOBLOCK: 'false', MAINNET_ABUSE_IP_ATTEMPTS_PER_HOUR: '1' })
  const ip = '198.51.100.88'
  assert.equal((await h.drip('usdfc', addr(1), { ip })).status, 200)
  assert.equal((await h.drip('usdfc', addr(2), { ip })).status, 200)
  assert.match((await h.app.inject({ url: '/metrics' })).body, /plumbline_mainnet_abuse_trips_total\{rule="ip_velocity"\} 1/)
  assert.equal(h.ledger.listBlocks(h.clock.t).length, 0)
})

test('API key traffic is excluded from IP rotation rules', async () => {
  const h = await harness()
  const key = h.ledger.createApiKey({ name: 'ci', capUsdfcMicro: 100_000_000n, capFilMicro: 1_000_000n, windowSec: 7 * DAY, nowUnix: h.clock.t })
  const ip = '198.51.100.99'
  // 4 distinct addresses from one IP would trip ip_address_rotation (> 3) anonymously.
  for (let i = 0; i < 4; i++) assert.equal((await h.drip('usdfc', addr(100 + i), { ip, apiKey: key })).status, 200)
})

test('admin CLI: manual block, unblock, key lifecycle', async () => {
  const db = path.join(mkdtempSync(path.join(tmpdir(), 'plmn-admin-')), 'mainnet.sqlite')
  const created = runAdmin(['key', 'create', '--name', 'synaps3', '--cap-usdfc', '50', '--cap-fil', '0.5'], db)
  const key = created.split('\n')[1]!
  assert.match(key, /^plmn_[A-Za-z0-9_-]{32}$/)
  const list = JSON.parse(runAdmin(['key', 'list'], db))
  assert.equal(list[0].name, 'synaps3')
  assert.equal(list[0].capUsdfc, '50')
  assert.ok(!JSON.stringify(list).includes(key))
  assert.equal(runAdmin(['key', 'revoke', '--name', 'synaps3'], db), 'revoked "synaps3"')
  assert.match(runAdmin(['block', 'add', '--kind', 'ip', '--value', '198.51.100.1', '--hours', '2'], db), /blocked ip/)
  assert.equal(JSON.parse(runAdmin(['block', 'list'], db)).length, 1)
  assert.equal(runAdmin(['block', 'remove', '--kind', 'ip', '--value', '198.51.100.1'], db), 'removed')
  const summary = JSON.parse(runAdmin(['summary'], db))
  assert.equal(summary.usdfc.monthToDate, '0')
})
