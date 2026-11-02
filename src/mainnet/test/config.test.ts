// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, fromMicro, loadMainnetConfig, MAINNET_USDFC_ADDRESS, toMicro } from '../config.js'
import { baseEnv } from './helpers.js'

test('defaults are the documented conservative caps', () => {
  const c = loadMainnetConfig(baseEnv())
  assert.equal(c.chainId, 314)
  assert.equal(c.usdfcAddress, MAINNET_USDFC_ADDRESS)
  assert.equal(c.rpcUrl, 'https://api.node.glif.io/rpc/v1')
  assert.equal(c.port, 8006)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.addressWindowSec, 7 * 86400)
  assert.equal(c.ipWindowSec, 7 * 86400)
  const u = c.assets.usdfc
  const f = c.assets.fil
  assert.deepEqual(
    [u.dripMicro, u.addressCapMicro, u.ipCapMicro, u.subnetCapMicro, u.dailyCapMicro, u.monthlyCapMicro, u.reserveFloorMicro].map(fromMicro),
    ['5', '5', '10', '20', '25', '100', '10'],
  )
  assert.deepEqual(
    [f.dripMicro, f.addressCapMicro, f.ipCapMicro, f.subnetCapMicro, f.dailyCapMicro, f.monthlyCapMicro, f.reserveFloorMicro].map(fromMicro),
    ['0.05', '0.05', '0.1', '0.2', '0.25', '1', '0.5'],
  )
  assert.equal(c.killSwitch, false) // baseEnv sets MAINNET_KILL_SWITCH=0
  assert.equal(c.minGasFilMicro, 10_000n)
  assert.match(c.statusNote, /not yet activated/)
  assert.equal(c.turnstileAction, 'mainnet-drip')
  assert.equal(c.abuse.autoBlock, true)
})

test('kill switch ships ON: drips are disabled unless MAINNET_KILL_SWITCH=0', () => {
  const env = baseEnv()
  delete (env as Record<string, string | undefined>).MAINNET_KILL_SWITCH
  assert.equal(loadMainnetConfig(env).killSwitch, true)
  assert.equal(loadMainnetConfig({ ...env, MAINNET_KILL_SWITCH: '' }).killSwitch, true)
  assert.equal(loadMainnetConfig({ ...env, MAINNET_KILL_SWITCH: '0' }).killSwitch, false)
})

test('fail-closed validation', () => {
  const bad = (extra: Record<string, string>, re: RegExp) =>
    assert.throws(() => loadMainnetConfig({ ...baseEnv(), ...extra }), (e: unknown) => e instanceof ConfigError && re.test(e.message))
  bad({ NETWORK: 'calibration' }, /NETWORK=mainnet/)
  bad({ MAINNET_TURNSTILE_SECRET: '' }, /TURNSTILE/)
  bad({ MAINNET_TURNSTILE_SITE_KEY: '' }, /TURNSTILE/)
  bad({ MAINNET_FAUCET_PK: '' }, /MAINNET_FAUCET_PK is required/)
  bad({ MAINNET_FAUCET_PK: '0x1234' }, /32-byte/)
  bad({ FAUCET_PK: '0x' + '11'.repeat(32) }, /must not equal the calibration/)
  bad({ MAINNET_FAUCET_PK: '', MAINNET_DRY_RUN: '1' }, /MAINNET_DRY_RUN_ADDRESS/)
  bad({ MAINNET_RPC_URL: 'https://api.calibration.node.glif.io/rpc/v1' }, /calibration endpoint/)
  bad({ MAINNET_ADDRESS_CAP_USDFC: '4' }, /ADDRESS_CAP_USDFC must be >=/)
  bad({ MAINNET_DAILY_CAP_FIL: '2' }, /DAILY_CAP_FIL must be <=/)
  bad({ MAINNET_USDFC_DRIP: '0.0000001' }, /at most 6 decimals/)
})

test('dry run with a watch-only address needs no key', () => {
  const c = loadMainnetConfig({ ...baseEnv(), MAINNET_FAUCET_PK: '', MAINNET_DRY_RUN: '1', MAINNET_DRY_RUN_ADDRESS: '0x0BEAB7Bdb375a0251284d5d32D1A2262cA60B9b4' })
  assert.equal(c.privateKey, null)
  assert.equal(c.dryRun, true)
})

test('micro-unit conversion is exact', () => {
  assert.equal(toMicro('5'), 5_000_000n)
  assert.equal(toMicro('0.05'), 50_000n)
  assert.equal(toMicro('123.456789'), 123_456_789n)
  assert.equal(fromMicro(50_000n), '0.05')
  assert.equal(fromMicro(5_000_000n), '5')
  assert.throws(() => toMicro('-1'))
  assert.throws(() => toMicro('1e3'))
})
