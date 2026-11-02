// SPDX-License-Identifier: MIT
//
// Caps, rate limits, reserve floor, kill switch and API keys, exercised
// through the real HTTP routes with a fake dispenser and a fake clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unlinkSync, writeFileSync } from 'node:fs'
import { WEI, T0, addr, harness } from './helpers.js'

const DAY = 86_400

test('no anonymous no-captcha route exists on mainnet', async () => {
  const h = await harness()
  for (const [method, url] of [
    ['POST', '/api/public/drip/usdfc'],
    ['POST', '/api/public/drip/fil'],
    ['GET', '/api/claim_token_all?address=' + addr(1)],
    ['POST', '/api/drip'],
  ] as const) {
    const r = await h.app.inject({ method, url, payload: method === 'POST' ? { address: addr(1) } : undefined })
    assert.equal(r.statusCode, 404, url)
  }
  const r = await h.drip('usdfc', addr(1), { token: '' })
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'captcha')
  const bad = await h.drip('usdfc', addr(1), { token: 'forged' })
  assert.equal(bad.body.error, 'captcha')
  assert.equal(h.disp.sends.length, 0)
})

test('recipient validation: 0x and f410f only', async () => {
  const h = await harness()
  assert.equal((await h.drip('usdfc', 't410fkkld55ioe7qg24wvt7fu6pbknb56ht7pt4zamxa')).body.error, 'testnet_address')
  assert.equal((await h.drip('fil', 'f1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za')).body.error, 'native_address_unsupported')
  assert.equal((await h.drip('fil', 'f01234')).body.error, 'native_address_unsupported')
  assert.equal((await h.drip('usdfc', '0x123')).body.error, 'invalid_address')
  assert.equal((await h.drip('usdfc', h.disp.address)).body.error, 'recipient_not_allowed')
  assert.equal((await h.drip('usdfc', h.cfg.usdfcAddress)).body.error, 'recipient_not_allowed')
  // f410f maps to the embedded 0x address.
  const ok = await h.drip('usdfc', 'f410fkkld55ioe7qg24wvt7fu6pbknb56ht7pt4zamxa')
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.to, '0x52963ef50e27e06d72d59fcb4f3c2a687be3cfef')
})

test('per-address cap: 5 USDFC per rolling 7 days, exact boundary', async () => {
  const h = await harness()
  const a = addr(2)
  const first = await h.drip('usdfc', a)
  assert.equal(first.status, 200)
  assert.equal(first.body.amount, '5')
  assert.equal(h.disp.sends[0]!.amount, 5n * WEI)
  const second = await h.drip('usdfc', a, { ip: '203.0.113.50' })
  assert.equal(second.status, 429)
  assert.equal(second.body.error, 'address_cap')
  assert.equal(second.body.used, '5')
  assert.equal(second.body.cap, '5')
  assert.equal(second.body.retryAfterSec, 7 * DAY + 1)
  assert.equal(second.headers['retry-after'], String(7 * DAY + 1))
  // Address case does not matter.
  assert.equal((await h.drip('usdfc', a.toUpperCase().replace('0X', '0x'), { ip: '203.0.113.51' })).body.error, 'address_cap')
  // Still capped one second before the window ends.
  h.clock.t = T0 + 7 * DAY - 1
  assert.equal((await h.drip('usdfc', a, { ip: '203.0.113.52' })).status, 429)
  h.clock.t = T0 + 7 * DAY
  assert.equal((await h.drip('usdfc', a, { ip: '203.0.113.53' })).status, 200)
})

test('FIL cap is independent of USDFC', async () => {
  const h = await harness()
  const a = addr(3)
  assert.equal((await h.drip('usdfc', a)).status, 200)
  const fil = await h.drip('fil', a)
  assert.equal(fil.status, 200)
  assert.equal(fil.body.amount, '0.05')
  assert.equal(h.disp.sends[1]!.amount, 5n * 10n ** 16n)
  assert.equal((await h.drip('fil', a)).body.error, 'address_cap')
})

test('per-IP cap (anonymous path): 10 USDFC per IP per 7 days', async () => {
  const h = await harness()
  const ip = '198.51.100.20'
  assert.equal((await h.drip('usdfc', addr(10), { ip })).status, 200)
  assert.equal((await h.drip('usdfc', addr(11), { ip })).status, 200)
  const third = await h.drip('usdfc', addr(12), { ip })
  assert.equal(third.status, 429)
  assert.equal(third.body.error, 'ip_cap')
  assert.equal(third.body.used, '10')
})

test('per-subnet cap: /24 shares a 20 USDFC budget', async () => {
  const h = await harness()
  for (let i = 0; i < 4; i++) {
    assert.equal((await h.drip('usdfc', addr(20 + i), { ip: '192.0.2.' + (10 + i) })).status, 200)
  }
  const fifth = await h.drip('usdfc', addr(25), { ip: '192.0.2.99' })
  assert.equal(fifth.status, 429)
  assert.equal(fifth.body.error, 'subnet_cap')
  // A different /24 is unaffected.
  assert.equal((await h.drip('usdfc', addr(26), { ip: '192.0.3.1' })).status, 200)
})

test('global daily cap refuses with 503 and retry hint', async () => {
  const h = await harness({ MAINNET_DAILY_CAP_USDFC: '10' })
  assert.equal((await h.drip('usdfc', addr(30), { ip: '198.51.100.30' })).status, 200)
  h.clock.t += 3600
  assert.equal((await h.drip('usdfc', addr(31), { ip: '203.0.113.31' })).status, 200)
  const r = await h.drip('usdfc', addr(32), { ip: '192.0.2.32' })
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'daily_cap_reached')
  assert.equal(r.body.retryAfterSec, DAY - 3600 + 1)
  h.clock.t = T0 + DAY + 1
  assert.equal((await h.drip('usdfc', addr(32), { ip: '192.0.2.32' })).status, 200)
})

test('global monthly cap is a hard stop until the next UTC month', async () => {
  const h = await harness({ MAINNET_MONTHLY_CAP_USDFC: '10', MAINNET_DAILY_CAP_USDFC: '10' })
  assert.equal((await h.drip('usdfc', addr(40), { ip: '198.51.100.40' })).status, 200)
  assert.equal((await h.drip('usdfc', addr(41), { ip: '203.0.113.41' })).status, 200)
  h.clock.t = T0 + 2 * DAY
  const r = await h.drip('usdfc', addr(42), { ip: '192.0.2.42' })
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'monthly_cap_reached')
  assert.equal(r.body.used, '10')
  assert.equal(r.body.cap, '10')
  const feb1 = Math.floor(Date.UTC(2027, 1, 1) / 1000)
  assert.equal(r.body.retryAtUnix, feb1)
  // FIL has its own monthly budget.
  assert.equal((await h.drip('fil', addr(42), { ip: '192.0.2.42' })).status, 200)
  h.clock.t = feb1 - 1
  assert.equal((await h.drip('usdfc', addr(43), { ip: '192.0.2.43' })).body.error, 'monthly_cap_reached')
  h.clock.t = feb1
  assert.equal((await h.drip('usdfc', addr(43), { ip: '192.0.2.43' })).status, 200)
})

test('float reserve floor: refuses below floor + drip, boundary is exact', async () => {
  const h = await harness()
  // floor 10 USDFC + drip 5 => need >= 15 USDFC
  h.disp.bal.usdfc = 15n * WEI - 1n
  const r = await h.drip('usdfc', addr(50))
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'faucet_dry')
  assert.equal(r.body.funded, false)
  assert.equal(r.body.floor, '10')
  assert.match(r.body.statusNote, /not yet activated/)
  assert.equal(h.disp.sends.length, 0)
  assert.equal(h.ledger.sumOutflow({ asset: 'usdfc', sinceUnix: 0 }), 0n)
  const status = (await h.app.inject({ url: '/api/status' })).json()
  assert.equal(status.assets.usdfc.reserveBreach, true)
  const metrics = (await h.app.inject({ url: '/metrics' })).body
  assert.match(metrics, /plumbline_mainnet_reserve_breach\{asset="usdfc"\} 1/)
  assert.match(metrics, /plumbline_mainnet_reserve_breach\{asset="fil"\} 0/)
  await h.state.evaluateAlerts(0)
  assert.ok(h.alerts.some((a) => a.alert === 'reserve_breach:usdfc' && a.severity === 'critical'))
  h.disp.bal.usdfc = 15n * WEI
  h.state.invalidate()
  assert.equal((await h.drip('usdfc', addr(50))).status, 200)
})

test('zero float: both assets refuse with preview_unfunded, status and metrics say funded=false', async () => {
  const h = await harness()
  h.disp.bal = { usdfc: 0n, fil: 0n }
  for (const asset of ['usdfc', 'fil'] as const) {
    const r = await h.drip(asset, addr(150))
    assert.equal(r.status, 503)
    assert.equal(r.body.error, 'preview_unfunded')
    assert.equal(r.body.funded, false)
    assert.equal(r.body.balance, '0')
    assert.match(r.body.statusNote, /docs\/mainnet-preview\.md/)
  }
  assert.equal(h.disp.sends.length, 0)
  assert.equal(h.ledger.sumOutflow({ asset: 'usdfc', sinceUnix: 0 }), 0n)
  const s = (await h.app.inject({ url: '/api/status' })).json()
  assert.equal(s.funded, false)
  assert.equal(s.assets.usdfc.funded, false)
  assert.equal(s.assets.usdfc.unfundedReason, 'preview_unfunded')
  assert.equal(s.assets.usdfc.balance, '0')
  assert.equal(s.assets.usdfc.reserveFloor, '10')
  assert.equal(s.assets.usdfc.monthToDate, '0')
  assert.equal(s.assets.usdfc.monthlyCap, '100')
  assert.equal(s.assets.fil.acceptingDrips, false)
  const m = (await h.app.inject({ url: '/metrics' })).body
  assert.match(m, /plumbline_mainnet_funded\{asset="usdfc"\} 0\n/)
  assert.match(m, /plumbline_mainnet_funded\{asset="fil"\} 0\n/)
  assert.match(m, /plumbline_mainnet_dispenser_balance_wei\{asset="usdfc"\} 0\n/)
  assert.match(m, /plumbline_mainnet_outflow_month_cap_wei\{asset="usdfc"\} 100000000000000000000\n/)
  // Live (not paused) and unfunded: the operator is paged.
  await h.state.evaluateAlerts(0)
  assert.ok(h.alerts.some((a) => a.alert === 'reserve_breach:usdfc'))
})

test('USDFC funded but no FIL for gas: USDFC refuses with faucet_dry', async () => {
  const h = await harness({ MAINNET_RESERVE_FLOOR_FIL: '0' })
  h.disp.bal = { usdfc: 1000n * WEI, fil: 0n }
  const r = await h.drip('usdfc', addr(160))
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'faucet_dry')
  assert.match(r.body.reason, /gas/)
  h.disp.bal.fil = WEI / 10n
  h.state.invalidate()
  assert.equal((await h.drip('usdfc', addr(160))).status, 200)
})

test('shipped default (kill switch on, zero float): paused, visible, no paging', async () => {
  const h = await harness({ MAINNET_KILL_SWITCH: '' })
  h.disp.bal = { usdfc: 0n, fil: 0n }
  const r = await h.drip('usdfc', addr(170))
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'mainnet_paused')
  assert.match(r.body.reason, /not yet activated/)
  assert.match(r.body.statusNote, /not yet activated/)
  const s = (await h.app.inject({ url: '/api/status' })).json()
  assert.equal(s.paused, true)
  assert.equal(s.activated, false)
  assert.equal(s.label, 'Mainnet preview (not yet activated)')
  const info = (await h.app.inject({ url: '/api/info' })).json()
  assert.equal(info.activated, false)
  assert.equal(info.label, 'Mainnet preview (not yet activated)')
  assert.equal(s.funded, false)
  assert.equal(s.assets.usdfc.acceptingDrips, false)
  await h.state.evaluateAlerts(0)
  h.clock.t += 7200
  await h.state.evaluateAlerts(0)
  assert.equal(h.alerts.filter((a) => a.alert === 'kill_switch').length, 1, 'kill switch alert fires once, not hourly')
  assert.ok(!h.alerts.some((a) => String(a.alert).startsWith('reserve_')), 'no reserve paging while paused')
  assert.match((await h.app.inject({ url: '/metrics' })).body, /plumbline_mainnet_paused 1/)
})

test('kill switch: env flag and kill file both stop drips', async () => {
  const env = await harness({ MAINNET_KILL_SWITCH: '1' })
  const r = await env.drip('usdfc', addr(60))
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'mainnet_paused')
  assert.equal(env.disp.sends.length, 0)
  assert.equal((await env.app.inject({ url: '/healthz' })).json().paused, true)

  const h = await harness()
  writeFileSync(h.cfg.killFile, '')
  assert.equal((await h.drip('usdfc', addr(61))).body.error, 'mainnet_paused')
  assert.match((await h.app.inject({ url: '/metrics' })).body, /plumbline_mainnet_paused 1/)
  unlinkSync(h.cfg.killFile)
  assert.equal((await h.drip('usdfc', addr(61))).status, 200)
})

test('send failure before broadcast is not counted; after broadcast it is', async () => {
  const h = await harness()
  h.disp.failBeforeBroadcast = true
  const r = await h.drip('usdfc', addr(70))
  assert.equal(r.status, 500)
  assert.equal(r.body.error, 'drip_failed')
  h.disp.failBeforeBroadcast = false
  assert.equal((await h.drip('usdfc', addr(70))).status, 200)

  // Broadcast but receipt not seen in time: 202, and it counts.
  h.disp.receipt = 'pending'
  const r2 = await h.drip('usdfc', addr(71), { ip: '203.0.113.71' })
  assert.equal(r2.status, 202)
  assert.equal(r2.body.status, 'submitted')
  assert.ok(r2.body.txHash)
  assert.match(r2.body.explorerUrl, /^https:\/\/filecoin\.blockscout\.com\/tx\/0x/)
  assert.equal((await h.drip('usdfc', addr(71), { ip: '203.0.113.72' })).body.error, 'address_cap')
  // In-flight (unconfirmed) amounts are subtracted from the float for
  // the reserve check: 15 USDFC on chain minus 5 in flight is below
  // floor 10 + drip 5.
  h.disp.bal.usdfc = 15n * WEI
  h.state.invalidate()
  assert.equal((await h.drip('usdfc', addr(73), { ip: '192.0.2.73' })).body.error, 'preview_unfunded')
  h.disp.bal.usdfc = 10_000n * WEI

  // Included but reverted: 500, and it does not count.
  h.disp.receipt = 'reverted'
  const r3 = await h.drip('usdfc', addr(72), { ip: '198.18.0.72' })
  assert.equal(r3.status, 500, JSON.stringify(r3.body))
  assert.equal(r3.body.error, 'drip_reverted')
  h.disp.receipt = 'confirmed'
  assert.equal((await h.drip('usdfc', addr(72), { ip: '198.18.0.73' })).status, 200)
})

test('concurrent requests cannot overshoot a cap', async () => {
  const h = await harness()
  h.disp.delayMs = 30
  const a = addr(80)
  const rs = await Promise.all(['198.51.100.81', '203.0.113.82', '192.0.2.83'].map((ip) => h.drip('usdfc', a, { ip })))
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429, 429])
  assert.equal(h.disp.sends.length, 1)
})

test('queue limit returns 503 busy', async () => {
  const h = await harness({ MAINNET_MAX_QUEUE: '1' })
  h.disp.delayMs = 100
  const [a, b] = await Promise.all([h.drip('usdfc', addr(90)), h.drip('usdfc', addr(91), { ip: '203.0.113.91' })])
  assert.deepEqual([a.status, b.status].sort(), [200, 503])
  assert.equal([a, b].find((r) => r.status === 503)!.body.error, 'busy')
})

test('X-Forwarded-For is only trusted from the local proxy', async () => {
  const h = await harness()
  await h.drip('usdfc', addr(95), { ip: '1.1.1.1', remote: '203.0.113.200' })
  const row = h.ledger.db.prepare('SELECT ip, subnet FROM mainnet_ledger ORDER BY id DESC LIMIT 1').get() as { ip: string; subnet: string }
  assert.equal(row.ip, '203.0.113.200')
  assert.equal(row.subnet, '203.0.113.0/24')
  await h.drip('usdfc', addr(96), { ip: '1.1.1.1', remote: '127.0.0.1' })
  const row2 = h.ledger.db.prepare('SELECT ip FROM mainnet_ledger ORDER BY id DESC LIMIT 1').get() as { ip: string }
  assert.equal(row2.ip, '1.1.1.1')
})

test('API keys: named integrator, no captcha, own cap, hashed at rest', async () => {
  const h = await harness()
  const key = h.ledger.createApiKey({ name: 'synaps3', capUsdfcMicro: 10_000_000n, capFilMicro: 100_000n, windowSec: 7 * DAY, nowUnix: T0 })
  const dump = JSON.stringify(h.ledger.db.prepare('SELECT * FROM mainnet_api_keys').all())
  assert.ok(!dump.includes(key), 'plaintext key must not be stored')
  const ip = '198.51.100.100'
  assert.equal((await h.drip('usdfc', addr(100), { apiKey: key, ip })).status, 200)
  // Per-address cap still applies to keyed traffic.
  assert.equal((await h.drip('usdfc', addr(100), { apiKey: key, ip })).body.error, 'address_cap')
  // Keyed traffic skips the per-IP cap (same IP, would be ip_cap on the third drip anonymously) ...
  assert.equal((await h.drip('usdfc', addr(101), { apiKey: key, ip })).status, 200)
  // ... but has its own cap (10 USDFC per 7 days).
  const capped = await h.drip('usdfc', addr(102), { apiKey: key, ip })
  assert.equal(capped.status, 429)
  assert.equal(capped.body.error, 'api_key_cap')
  // Keyed drips do not use up the anonymous per-IP budget.
  assert.equal((await h.drip('usdfc', addr(103), { ip })).status, 200)
  assert.equal((await h.drip('usdfc', addr(104), { apiKey: 'plmn_nope', ip })).body.error, 'invalid_api_key')
  h.ledger.setApiKeyEnabled('synaps3', false)
  const revoked = await h.drip('fil', addr(105), { apiKey: key, ip })
  assert.equal(revoked.status, 401)
  assert.equal(revoked.body.error, 'revoked_api_key')
})

test('/api/check, /api/status, /api/info and /metrics report the ledger', async () => {
  const h = await harness()
  const a = addr(110)
  assert.equal((await h.drip('usdfc', a)).status, 200)
  await h.drip('usdfc', a)
  const check = (await h.app.inject({ url: '/api/check?address=' + a })).json()
  assert.equal(check.usdfc.remaining, '0')
  assert.equal(check.usdfc.eligibleNow, false)
  assert.equal(check.usdfc.nextEligibleUnix, T0 + 7 * DAY + 1)
  assert.equal(check.fil.eligibleNow, true)
  const status = (await h.app.inject({ url: '/api/status' })).json()
  assert.equal(status.network, 'mainnet')
  assert.equal(status.assets.usdfc.monthToDate, '5')
  assert.equal(status.assets.usdfc.monthlyRemaining, '95')
  assert.equal(status.assets.usdfc.dripsThisMonth, 1)
  assert.equal(status.assets.usdfc.balance, '9995')
  const info = (await h.app.inject({ url: '/api/info' })).json()
  assert.equal(info.policy.usdfc.perAddressCap, '5')
  assert.equal(info.policy.fil.monthlyGlobalCap, '1')
  assert.equal(info.captcha.siteKey, 'site-key')
  assert.ok(!JSON.stringify(info).includes('secret'))
  const m = (await h.app.inject({ url: '/metrics' })).body
  assert.match(m, /plumbline_mainnet_outflow_month_wei\{asset="usdfc"\} 5000000000000000000\n/)
  assert.match(m, /plumbline_mainnet_outflow_month_cap_wei\{asset="usdfc"\} 100000000000000000000\n/)
  assert.match(m, /plumbline_mainnet_drips_total\{asset="usdfc"\} 1\n/)
  assert.match(m, /plumbline_mainnet_refused_total\{reason="address_cap"\} 1\n/)
  assert.match(m, /plumbline_mainnet_dispenser_balance_wei\{asset="usdfc"\} 9995000000000000000000\n/)
  assert.match(m, /plumbline_mainnet_reserve_floor_wei\{asset="fil"\} 500000000000000000\n/)
  const recent = (await h.app.inject({ url: '/api/recent' })).json()
  assert.equal(recent.drips.length, 1)
  assert.equal(recent.drips[0].amount, '5')
})

test('monthly 80% alert fires once per repeat window', async () => {
  const h = await harness({ MAINNET_MONTHLY_CAP_USDFC: '25', MAINNET_DAILY_CAP_USDFC: '25', MAINNET_IP_CAP_USDFC: '100', MAINNET_SUBNET_CAP_USDFC: '100' })
  for (let i = 0; i < 4; i++) assert.equal((await h.drip('usdfc', addr(120 + i), { ip: '198.51.' + i + '.1' })).status, 200)
  await h.state.evaluateAlerts(0)
  await h.state.evaluateAlerts(0)
  assert.equal(h.alerts.filter((a) => a.alert === 'monthly_cap_80:usdfc').length, 1)
  assert.equal((await h.drip('usdfc', addr(130), { ip: '203.0.113.130' })).status, 200)
  await h.state.evaluateAlerts(0)
  assert.equal(h.alerts.filter((a) => a.alert === 'monthly_cap_reached:usdfc').length, 1)
  assert.ok(typeof h.alerts[0]!.text === 'string')
})

test('rpc failure while reading the float refuses with 503', async () => {
  const h = await harness()
  h.disp.rpcDown = true
  const r = await h.drip('usdfc', addr(140))
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'rpc_unavailable')
  assert.match((await h.app.inject({ url: '/metrics' })).body, /plumbline_mainnet_rpc_ok 0/)
})
