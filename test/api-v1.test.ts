// SPDX-License-Identifier: MIT
//
// Integration tests for the builder API v1. Spawns the real entry point
// (src/server.ts) against a fake RPC and a fake Calix. No real chain.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeRpc, startFakeCalix, startFaucet, type FakeRpc, type FakeCalix, type FaucetProc } from './fakes.js'

type J = Record<string, any>

async function get(base: string, p: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, { headers })
  const text = await r.text()
  let body: J = {}
  try { body = JSON.parse(text) } catch { body = { _raw: text } }
  return { status: r.status, headers: r.headers, body }
}

async function post(base: string, p: string, json: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(json),
  })
  const text = await r.text()
  let body: J = {}
  try { body = JSON.parse(text) } catch { body = { _raw: text } }
  return { status: r.status, headers: r.headers, body }
}

const ip = (n: number) => ({ 'x-forwarded-for': '198.51.100.' + n })
// Outside the precompile ranges refused as unspendable.
const addr = (n: number) => '0xab' + n.toString(16).padStart(38, '0')

describe('builder API v1 (main instance)', () => {
  let rpc: FakeRpc
  let calix: FakeCalix
  let f: FaucetProc

  before(async () => {
    rpc = await startFakeRpc()
    calix = await startFakeCalix()
    f = await startFaucet({
      RPC_URL: rpc.url,
      CALIX_URL: calix.url,
      CALIX_PUBLIC_URL: 'https://calix.example',
      UPSTREAM_CACHE_SEC: '1',
      UPSTREAM_STALE_MAX_SEC: '600',
      FAUCET_STATUS_CACHE_SEC: '1',
      MIN_RESERVE_FIL: '20',
      MIN_RESERVE_USDFC: '500',
      FIL_DRIP: '5',
      USDFC_DRIP: '100',
      BRAND_URL: 'https://faucet.example',
    })
  })
  after(async () => {
    await f?.stop()
    await rpc?.close()
    await calix?.close()
  })

  test('index lists every endpoint with apiVersion 1, CORS * and RateLimit headers', async () => {
    const r = await get(f.base, '/api/v1', { origin: 'https://some-tool.example', ...ip(1) })
    assert.equal(r.status, 200)
    assert.equal(r.body.apiVersion, '1')
    assert.equal(r.body.ok, true)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    assert.match(r.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(r.headers.get('ratelimit-limit'), '60')
    assert.ok(Number(r.headers.get('ratelimit-remaining')) <= 59)
    assert.ok(Number(r.headers.get('ratelimit-reset')) >= 1)
    const paths = r.body.endpoints.map((e: J) => e.method + ' ' + e.path)
    for (const p of [
      'GET /api/v1', 'GET /api/v1/faucet/status', 'GET /api/v1/faucet/drips', 'GET /api/v1/network',
      'GET /api/v1/sp', 'GET /api/v1/openapi.json', 'POST /api/v1/drip/fil', 'POST /api/v1/drip/usdfc',
    ]) assert.ok(paths.includes(p), 'missing ' + p)
    const slash = await get(f.base, '/api/v1/', ip(1))
    assert.equal(slash.status, 200)
  })

  test('openapi.json is 3.1 and describes every indexed endpoint', async () => {
    const idx = await get(f.base, '/api/v1', ip(2))
    const r = await get(f.base, '/api/v1/openapi.json', ip(2))
    assert.equal(r.status, 200)
    assert.equal(r.body.openapi, '3.1.0')
    assert.equal(r.body.apiVersion, undefined, 'spec root must stay a valid OpenAPI object')
    assert.equal(r.body['x-apiVersion'], '1')
    assert.equal(r.headers.get('x-api-version'), '1')
    for (const e of idx.body.endpoints) {
      const op = r.body.paths[e.path]?.[e.method.toLowerCase()]
      assert.ok(op, 'openapi missing ' + e.method + ' ' + e.path)
    }
    assert.equal(r.body.servers[0].url, 'https://faucet.example')
  })

  test('faucet/status reports balances, reserve floors, drip amounts and limits', async () => {
    const r = await get(f.base, '/api/v1/faucet/status', ip(3))
    assert.equal(r.status, 200)
    const b = r.body
    assert.equal(b.apiVersion, '1')
    assert.equal(b.network, 'calibration')
    assert.equal(b.chainId, 314159)
    assert.equal(b.healthy, true)
    assert.equal(b.state, 'ok')
    assert.equal(b.rpcOk, true)
    assert.match(b.dispenser, /^0x[0-9a-fA-F]{40}$/)
    assert.equal(b.assets.fil.balanceWei, (10n ** 24n).toString())
    assert.equal(b.assets.fil.balance, '1000000')
    assert.equal(b.assets.fil.reserveFloor, '20')
    assert.equal(b.assets.fil.dripAmount, '5')
    assert.equal(b.assets.fil.publicDripAmount, '1')
    assert.equal(b.assets.usdfc.reserveFloor, '500')
    assert.equal(b.assets.usdfc.dripAmount, '100')
    assert.equal(b.assets.usdfc.canDrip, true)
    assert.match(b.assets.usdfc.contract, /^0x/)
    assert.deepEqual(b.limits.captcha.perIp, { max: 2, windowSec: 86400 })
    assert.deepEqual(b.limits.captcha.perAddress, { max: 2, windowSec: 86400 })
    assert.deepEqual(b.limits.public.perIp, { max: 1, windowSec: 86400 })
    assert.equal(b.limits.readRequestsPerIpPerMinute, 60)
    assert.ok(b.fetchedAt)
    assert.equal(b.stale, false)
  })

  test('faucet/status flags low reserve as watch', async () => {
    rpc.state.balanceWei = 10n ** 18n * 10n // 10 tFIL / 10 USDFC, below floor
    await new Promise((r) => setTimeout(r, 1100))
    const r = await get(f.base, '/api/v1/faucet/status', ip(3))
    assert.equal(r.status, 200)
    assert.equal(r.body.healthy, false)
    assert.equal(r.body.state, 'watch')
    assert.deepEqual(r.body.reasons, ['fil_below_reserve', 'usdfc_below_reserve'])
    assert.equal(r.body.assets.fil.canDrip, false)
    rpc.state.balanceWei = 10n ** 24n
    await new Promise((r) => setTimeout(r, 1100))
  })

  test('network aggregates Calix status + signals with source and fetchedAt, cached', async () => {
    const before = calix.state.hits['/api/v1/status'] ?? 0
    const r = await get(f.base, '/api/v1/network', ip(4))
    assert.equal(r.status, 200)
    const b = r.body
    assert.equal(b.apiVersion, '1')
    assert.equal(b.healthy, true)
    assert.equal(b.state, 'ok')
    assert.equal(b.level, 'operational')
    assert.equal(b.chain.epoch, 4209747)
    assert.equal(b.chain.networkVersion, 29)
    assert.equal(b.upgrade.name, 'Solstice')
    assert.equal(b.upgrade.activated, true)
    assert.equal(b.signals.blocksPerEpoch.value, 3.01)
    assert.equal(b.signals.activeMiners.status, 'watch')
    assert.equal(b.signals.series, undefined)
    assert.equal(b.source.name, 'calix')
    assert.equal(b.source.url, 'https://calix.example')
    assert.deepEqual(b.source.endpoints, ['/api/v1/status', '/api/v1/signals'])
    assert.ok(!Number.isNaN(Date.parse(b.fetchedAt)))
    assert.equal(b.stale, false)
    // second call inside the TTL is served from cache
    const mid = calix.state.hits['/api/v1/status'] ?? 0
    await get(f.base, '/api/v1/network', ip(4))
    assert.equal(calix.state.hits['/api/v1/status'], mid)
    assert.ok(mid >= before)
  })

  test('sp reports the test target from Calix miners/status', async () => {
    const r = await get(f.base, '/api/v1/sp', ip(5))
    assert.equal(r.status, 200)
    assert.equal(r.body.apiVersion, '1')
    assert.equal(r.body.healthy, true)
    assert.equal(r.body.targets.length, 1)
    assert.equal(r.body.targets[0].address, 't0143103')
    assert.equal(r.body.targets[0].status, 'ok')
    assert.equal(r.body.targets[0].blocksLast60, 54)
    assert.match(r.body.source.endpoints[0], /miners\/status\?addrs=t0143103/)
  })

  test('Calix failure: last good value is served as stale with upstreamError', async () => {
    await get(f.base, '/api/v1/network', ip(6))
    calix.state.down = true
    await new Promise((r) => setTimeout(r, 1200))
    const r = await get(f.base, '/api/v1/network', ip(6))
    assert.equal(r.status, 200)
    assert.equal(r.body.stale, true)
    assert.match(r.body.upstreamError, /HTTP 503/)
    const s = await get(f.base, '/api/v1/sp', ip(6))
    assert.equal(s.status, 200)
    assert.equal(s.body.stale, true)
    calix.state.down = false
    await new Promise((r) => setTimeout(r, 5200)) // error backoff
    const back = await get(f.base, '/api/v1/network', ip(6))
    assert.equal(back.body.stale, false)
  })

  test('drip aliases share handler, counters and limits with /api/drip/*', async () => {
    const a = addr(0xa11ce)
    // 1st drip via v1 alias
    const d1 = await post(f.base, '/api/v1/drip/fil', { address: a }, ip(20))
    assert.equal(d1.status, 200, JSON.stringify(d1.body))
    assert.equal(d1.body.apiVersion, '1')
    assert.equal(d1.body.ok, true)
    assert.match(d1.body.txHash, /^0x[0-9a-f]{64}$/)
    assert.equal(d1.body.amount, '5')
    // 2nd drip via legacy path, same IP + address: allowed (max 2)
    const d2 = await post(f.base, '/api/drip/fil', { address: a }, ip(20))
    assert.equal(d2.status, 200)
    assert.equal(d2.body.apiVersion, undefined, 'legacy response shape unchanged')
    // 3rd via v1: per-IP window (shared) is exhausted first
    const d3 = await post(f.base, '/api/v1/drip/fil', { address: a }, ip(20))
    assert.equal(d3.status, 429)
    assert.equal(d3.body.error, 'ip_rate_limited')
    assert.equal(d3.body.apiVersion, '1')
    assert.equal(d3.body.max, 2)
    assert.equal(typeof d3.body.message, 'string')
    assert.ok(d3.body.retryAtUnix > 0)
    // Same address from a new IP: per-address window (shared) is exhausted
    const d4 = await post(f.base, '/api/v1/drip/fil', { address: a }, ip(21))
    assert.equal(d4.status, 429)
    assert.equal(d4.body.error, 'address_rate_limited')
    const d5 = await post(f.base, '/api/drip/fil', { address: a }, ip(22))
    assert.equal(d5.status, 429)
    assert.equal(d5.body.error, 'address_rate_limited')
    // USDFC is an independent bucket and works through the alias
    const u1 = await post(f.base, '/api/v1/drip/usdfc', { address: a }, ip(23))
    assert.equal(u1.status, 200, JSON.stringify(u1.body))
    assert.equal(u1.body.asset, 'usdfc')
    assert.equal(u1.body.amount, '100')
  })

  test('drip alias validation errors match legacy codes', async () => {
    const bad1 = await post(f.base, '/api/v1/drip/fil', { address: 'nope' }, ip(30))
    const bad2 = await post(f.base, '/api/drip/fil', { address: 'nope' }, ip(30))
    assert.equal(bad1.status, 400)
    assert.equal(bad1.body.error, bad2.body.error)
    assert.equal(bad1.body.error, 'invalid_address')
    const n1 = await post(f.base, '/api/v1/drip/usdfc', { address: 't1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za' }, ip(31))
    assert.equal(n1.status, 400)
    assert.equal(n1.body.error, 'usdfc_native_unsupported')
    const k1 = await post(f.base, '/api/v1/drip/fil', { address: addr(5) }, { ...ip(32), authorization: 'Bearer pk_not_a_real_key' })
    const k2 = await post(f.base, '/api/drip/fil', { address: addr(5) }, { ...ip(32), authorization: 'Bearer pk_not_a_real_key' })
    assert.equal(k1.status, 401)
    assert.equal(k2.status, 401)
    assert.equal(k1.body.error, 'invalid_api_key')
    assert.equal(k1.body.error, k2.body.error)
    const empty = await post(f.base, '/api/v1/drip/fil', {}, ip(33))
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error, 'bad_request')
    const r = await fetch(f.base + '/api/v1/drip/fil', { method: 'POST', headers: { 'content-type': 'application/json', ...ip(34) }, body: '{not json' })
    const jb = await r.json() as J
    assert.equal(r.status, 400)
    assert.equal(jb.apiVersion, '1')
    assert.equal(jb.error, 'bad_request')
  })

  test('faucet/drips lists recent drips with amount, tx and explorer link; paginates', async () => {
    const r = await get(f.base, '/api/v1/faucet/drips?limit=2', ip(40))
    assert.equal(r.status, 200)
    assert.equal(r.body.apiVersion, '1')
    assert.equal(r.body.limit, 2)
    assert.equal(r.body.offset, 0)
    assert.equal(r.body.total, 3)
    assert.equal(r.body.nextOffset, 2)
    assert.equal(r.body.retention, 50)
    const d = r.body.drips[0]
    assert.ok(['fil', 'usdfc'].includes(d.asset))
    assert.match(d.tx, /^0x[0-9a-f]{64}$/)
    assert.equal(d.explorerUrl, 'https://calibration.filfox.info/en/message/' + d.tx)
    assert.ok(!Number.isNaN(Date.parse(d.time)))
    const amounts = r.body.drips.map((x: J) => x.asset + ':' + x.amount)
    assert.ok(amounts.every((s: string) => s === 'fil:5' || s === 'usdfc:100'), amounts.join(','))
    const p2 = await get(f.base, '/api/v1/faucet/drips?limit=2&offset=2', ip(40))
    assert.equal(p2.body.drips.length, 1)
    assert.equal(p2.body.nextOffset, null)
    const bad = await get(f.base, '/api/v1/faucet/drips?limit=500', ip(40))
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'bad_request')
    assert.equal(bad.body.apiVersion, '1')
    // legacy feed keeps its original shape
    const legacy = await get(f.base, '/api/recent?limit=1', ip(40))
    assert.deepEqual(Object.keys(legacy.body.drips[0]).sort(), ['address', 'asset', 'tx', 'unix'])
  })

  test('unknown v1 paths return a JSON 404 envelope', async () => {
    const r = await get(f.base, '/api/v1/nope', ip(50))
    assert.equal(r.status, 404)
    assert.equal(r.body.apiVersion, '1')
    assert.equal(r.body.ok, false)
    assert.equal(r.body.error, 'not_found')
    const d = await fetch(f.base + '/api/v1/faucet/status', { method: 'DELETE', headers: ip(50) })
    const db = await d.json() as J
    assert.equal(d.status, 404)
    assert.equal(db.error, 'not_found')
  })

  test('legacy endpoints still work', async () => {
    const r = await get(f.base, '/api/info', ip(60))
    assert.equal(r.status, 200)
    assert.equal(r.body.filDrip, '5')
    const h = await get(f.base, '/healthz', ip(60))
    assert.equal(h.body.ok, true)
  })
})

describe('builder API v1 (read rate limit)', () => {
  let rpc: FakeRpc
  let calix: FakeCalix
  let f: FaucetProc
  before(async () => {
    rpc = await startFakeRpc()
    calix = await startFakeCalix()
    f = await startFaucet({ RPC_URL: rpc.url, CALIX_URL: calix.url, API_V1_GET_RATE_LIMIT: '3' })
  })
  after(async () => {
    await f?.stop()
    await rpc?.close()
    await calix?.close()
  })

  test('per-IP GET budget returns JSON 429 with Retry-After; other IPs unaffected', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await get(f.base, '/api/v1', ip(1))
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('ratelimit-remaining'), String(2 - i))
    }
    const over = await get(f.base, '/api/v1/faucet/status', ip(1))
    assert.equal(over.status, 429)
    assert.equal(over.body.apiVersion, '1')
    assert.equal(over.body.ok, false)
    assert.equal(over.body.error, 'rate_limited')
    assert.equal(over.headers.get('ratelimit-remaining'), '0')
    assert.equal(over.headers.get('ratelimit-policy'), '3;w=60')
    assert.ok(Number(over.headers.get('retry-after')) >= 1)
    assert.equal(over.headers.get('access-control-allow-origin'), '*')
    const other = await get(f.base, '/api/v1', ip(2))
    assert.equal(other.status, 200)
    // POST drip aliases are not counted against the GET budget
    const d = await post(f.base, '/api/v1/drip/fil', { address: addr(9) }, ip(1))
    assert.equal(d.status, 200, JSON.stringify(d.body))
  })
})

describe('builder API v1 (Calix down from start, captcha on)', () => {
  let rpc: FakeRpc
  let f: FaucetProc
  before(async () => {
    rpc = await startFakeRpc()
    f = await startFaucet({
      RPC_URL: rpc.url,
      CALIX_URL: 'http://127.0.0.1:9', // nothing listens here
      UPSTREAM_TIMEOUT_MS: '1000',
      TURNSTILE_SECRET: 'test-secret-not-real',
      TURNSTILE_SITE_KEY: 'test-site-key',
    })
  })
  after(async () => {
    await f?.stop()
    await rpc?.close()
  })

  test('network and sp return 502 upstream_unavailable envelope', async () => {
    const n = await get(f.base, '/api/v1/network', ip(1))
    assert.equal(n.status, 502)
    assert.equal(n.body.apiVersion, '1')
    assert.equal(n.body.ok, false)
    assert.equal(n.body.error, 'upstream_unavailable')
    assert.equal(n.body.source.name, 'calix')
    assert.equal(n.headers.get('access-control-allow-origin'), '*')
    const s = await get(f.base, '/api/v1/sp', ip(1))
    assert.equal(s.status, 502)
    assert.equal(s.body.error, 'upstream_unavailable')
  })

  test('captcha is enforced identically on alias and legacy path', async () => {
    const a = await post(f.base, '/api/v1/drip/fil', { address: addr(1) }, ip(2))
    const b = await post(f.base, '/api/drip/fil', { address: addr(1) }, ip(2))
    assert.equal(a.status, 400)
    assert.equal(b.status, 400)
    assert.equal(a.body.error, 'captcha')
    assert.equal(a.body.reason, 'missing_token')
    assert.equal(a.body.error, b.body.error)
    assert.equal(a.body.reason, b.body.reason)
    assert.equal(a.body.message, 'missing_token')
    const st = await get(f.base, '/api/v1/faucet/status', ip(2))
    assert.equal(st.body.auth.captcha, 'turnstile')
    assert.equal(st.body.auth.turnstileSiteKey, 'test-site-key')
  })

})

describe('builder API v1 (RPC down from start)', () => {
  let rpc: FakeRpc
  let f: FaucetProc
  before(async () => {
    rpc = await startFakeRpc()
    rpc.state.down = true
    f = await startFaucet({ RPC_URL: rpc.url, CALIX_URL: 'http://127.0.0.1:9' })
  })
  after(async () => {
    await f?.stop()
    await rpc?.close()
  })

  test('faucet/status reports rpc_unreachable with null balances', async () => {
    const r = await get(f.base, '/api/v1/faucet/status', ip(1))
    assert.equal(r.status, 200)
    assert.equal(r.body.rpcOk, false)
    assert.equal(r.body.healthy, false)
    assert.equal(r.body.state, 'bad')
    assert.deepEqual(r.body.reasons, ['rpc_unreachable'])
    assert.equal(r.body.assets.fil.balance, null)
    assert.equal(r.body.assets.fil.reserveFloor, '20')
    assert.equal(typeof r.body.rpcError, 'string')
  })
})
