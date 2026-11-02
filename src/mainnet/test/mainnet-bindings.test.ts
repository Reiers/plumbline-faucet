// SPDX-License-Identifier: MIT
//
// Tests against the real Filecoin mainnet contract bindings.
//
// Read-only: eth_chainId, USDFC symbol/decimals/name/balanceOf, and
// transfer simulation with eth_call + eth_estimateGas from a funded
// mainnet holder. Nothing is signed or broadcast: the dispenser runs in
// dry-run mode with the holder as a watch-only address.
//
// Runs when MAINNET_RPC_TESTS=1 (CI sets it). Override the RPC with
// MAINNET_RPC_URL.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Address } from 'viem'
import { buildMainnetApp } from '../app.js'
import { loadMainnetConfig, MAINNET_USDFC_ADDRESS, type MainnetConfig } from '../config.js'
import { MainnetDispenser } from '../dispenser.js'
import { MainnetLedger } from '../ledger.js'
import { baseEnv } from './helpers.js'

const ENABLED = process.env.MAINNET_RPC_TESTS === '1'
const RPC = process.env.MAINNET_RPC_URL || 'https://api.node.glif.io/rpc/v1'
const WEI = 10n ** 18n

// Externally owned mainnet USDFC holders (from the Blockscout holder
// list, 2026-11). The first one that still holds >= 20 USDFC and
// >= 1 FIL is used. Read-only: we only simulate transfers from them.
const HOLDERS: Address[] = [
  '0x0BEAB7Bdb375a0251284d5d32D1A2262cA60B9b4',
  '0x0F218B3257b9914EDB88D755f163Dc6941d73Eb7',
  '0x5547083462cF65A63320C744633F9c8e57e291fB',
  '0x4B41Bf0dc82BF4C56c8a3A052159A7a9745c534E',
  '0xaff7B940026b4A705e749C84795224C1cD42014d',
]
// An address with zero FIL and zero USDFC on mainnet (no known key).
// Note: 0x...dEaD is not empty on Filecoin mainnet, it holds FIL.
const EMPTY: Address = '0x7e57000000000000000000000000000000000001'
const RECIPIENT: Address = '0x00000000000000000000000000000000c0ffee01'

const opts = { skip: ENABLED ? false : 'set MAINNET_RPC_TESTS=1 to run mainnet binding tests', timeout: 120_000 }

function dryCfg(holder: Address, extra: Record<string, string> = {}): MainnetConfig {
  return loadMainnetConfig(
    baseEnv({
      MAINNET_FAUCET_PK: '',
      MAINNET_DRY_RUN: '1',
      MAINNET_DRY_RUN_ADDRESS: holder,
      MAINNET_RPC_URL: RPC,
      MAINNET_TURNSTILE_ACTION: '',
      ...extra,
    }),
  )
}

let holderCache: Address | null = null
async function fundedHolder(): Promise<Address> {
  if (holderCache) return holderCache
  for (const h of HOLDERS) {
    const d = new MainnetDispenser(dryCfg(h))
    const b = await d.balances()
    if (b.usdfc >= 20n * WEI && b.fil >= WEI) return (holderCache = h)
  }
  throw new Error('no fixture holder has enough USDFC/FIL; refresh HOLDERS from Blockscout')
}

test('mainnet RPC is chain 314 and the USDFC binding matches the token', opts, async () => {
  const d = new MainnetDispenser(dryCfg(HOLDERS[0]!))
  assert.equal(await d.chainId(), 314)
  const info = await d.tokenInfo()
  assert.equal(info.symbol, 'USDFC')
  assert.equal(info.decimals, 18)
  assert.equal(info.name, 'USD for Filecoin Community')
  assert.equal(dryCfg(HOLDERS[0]!).usdfcAddress, MAINNET_USDFC_ADDRESS)
})

test('balanceOf / getBalance through the dispenser binding', opts, async () => {
  const h = await fundedHolder()
  const b = await new MainnetDispenser(dryCfg(h)).balances()
  assert.ok(b.usdfc >= 20n * WEI)
  assert.ok(b.fil >= WEI)
  const e = await new MainnetDispenser(dryCfg(EMPTY)).balances()
  assert.equal(e.usdfc, 0n)
  assert.equal(e.fil, 0n)
})

test('transfer simulation: funded holder succeeds, empty address reverts', opts, async () => {
  const h = await fundedHolder()
  const d = new MainnetDispenser(dryCfg(h))
  const u = await d.simulate('usdfc', RECIPIENT, 5n * WEI)
  assert.ok(u.gas > 0n)
  const f = await d.simulate('fil', RECIPIENT, 5n * 10n ** 16n)
  assert.ok(f.gas > 0n)
  const sent = await d.broadcast('usdfc', RECIPIENT, 5n * WEI)
  assert.equal(sent.simulated, true)
  assert.equal(sent.txHash, null)
  assert.ok(sent.gasEstimate > 0n)
  const empty = new MainnetDispenser(dryCfg(EMPTY))
  await assert.rejects(empty.simulate('usdfc', RECIPIENT, 5n * WEI))
  await assert.rejects(empty.simulate('fil', RECIPIENT, 5n * 10n ** 16n))
})

test('zero float against mainnet: unfunded watch-only dispenser refuses cleanly', opts, async () => {
  const cfg = dryCfg(EMPTY)
  const ledger = new MainnetLedger(':memory:', { countSimulated: true })
  const { app } = await buildMainnetApp({
    cfg,
    ledger,
    dispenser: new MainnetDispenser(cfg),
    captcha: async () => ({ ok: true }),
    logger: false,
  })
  await app.ready()
  for (const asset of ['usdfc', 'fil']) {
    const r = await app.inject({ method: 'POST', url: '/api/drip/' + asset, payload: { address: RECIPIENT, turnstileToken: 'x' } })
    assert.equal(r.statusCode, 503)
    assert.equal(r.json().error, 'preview_unfunded')
  }
  const s = (await app.inject({ url: '/api/status' })).json()
  assert.equal(s.funded, false)
  assert.equal(s.assets.usdfc.balance, '0')
  assert.equal(s.assets.fil.balance, '0')
  const m = (await app.inject({ url: '/metrics' })).body
  assert.match(m, /plumbline_mainnet_funded\{asset="usdfc"\} 0\n/)
  assert.match(m, /plumbline_mainnet_rpc_ok 1/)
})

async function liveApp(extra: Record<string, string> = {}) {
  const h = await fundedHolder()
  const cfg = dryCfg(h, extra)
  const ledger = new MainnetLedger(':memory:', { countSimulated: true })
  const { app, state } = await buildMainnetApp({
    cfg,
    ledger,
    dispenser: new MainnetDispenser(cfg),
    captcha: async (t) => (t === 'good' ? { ok: true } : { ok: false, reason: 'bad' }),
    logger: false,
  })
  await app.ready()
  const drip = async (asset: 'usdfc' | 'fil', address: string, ip: string) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/drip/${asset}`,
      payload: { address, turnstileToken: 'good' },
      headers: { 'x-forwarded-for': ip },
      remoteAddress: '127.0.0.1',
    })
    return { status: r.statusCode, body: r.json() }
  }
  return { app, state, ledger, drip, holder: h }
}

test('HTTP flow on mainnet bindings: caps, rate limits and abuse rules', opts, async () => {
  const { app, drip } = await liveApp({ MAINNET_RESERVE_FLOOR_USDFC: '1', MAINNET_RESERVE_FLOOR_FIL: '0.1' })
  const a1 = '0x00000000000000000000000000000000c0ffee11'
  const ok = await drip('usdfc', a1, '198.51.100.1')
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.status, 'simulated')
  assert.ok(Number(ok.body.gasEstimate) > 0)
  const fil = await drip('fil', a1, '198.51.100.1')
  assert.equal(fil.status, 200, JSON.stringify(fil.body))
  // per-address cap
  assert.equal((await drip('usdfc', a1, '203.0.113.1')).body.error, 'address_cap')
  // per-IP cap (10 USDFC per IP)
  assert.equal((await drip('usdfc', '0x00000000000000000000000000000000c0ffee12', '198.51.100.1')).status, 200)
  assert.equal((await drip('usdfc', '0x00000000000000000000000000000000c0ffee13', '198.51.100.1')).body.error, 'ip_cap')
  // abuse: 4th distinct address from the same IP blocks it
  const blocked = await drip('fil', '0x00000000000000000000000000000000c0ffee14', '198.51.100.1')
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.scope, 'ip')
  // metrics reflect the real on-chain float
  const m = (await app.inject({ url: '/metrics' })).body
  const bal = m.match(/plumbline_mainnet_dispenser_balance_wei\{asset="usdfc"\} (\d+)/)
  assert.ok(bal && BigInt(bal[1]!) >= 20n * WEI, 'usdfc balance gauge from mainnet')
  assert.match(m, /plumbline_mainnet_reserve_breach\{asset="usdfc"\} 0/)
  assert.match(m, /plumbline_mainnet_outflow_month_wei\{asset="usdfc"\} 10000000000000000000\n/)
  assert.match(m, /plumbline_mainnet_rpc_ok 1/)
})

test('float reserve floor against the real mainnet balance', opts, async () => {
  const h = await fundedHolder()
  const real = await new MainnetDispenser(dryCfg(h)).balances()
  // Floor set just above the real balance: must refuse and alert.
  const floor = (real.usdfc / WEI + 1n).toString()
  const { app, state, drip } = await liveApp({
    MAINNET_RESERVE_FLOOR_USDFC: floor,
    MAINNET_ADDRESS_CAP_USDFC: '5',
  })
  const r = await drip('usdfc', '0x00000000000000000000000000000000c0ffee21', '198.51.100.2')
  assert.equal(r.status, 503)
  assert.equal(r.body.error, 'preview_unfunded')
  const status = (await app.inject({ url: '/api/status' })).json()
  assert.equal(status.assets.usdfc.funded, false)
  assert.equal(status.assets.fil.funded, true)
  await state.evaluateAlerts(0)
  assert.ok(state.alerter.active.has('reserve_breach:usdfc'))
})
