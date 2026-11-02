// SPDX-License-Identifier: MIT
//
// Shared test helpers: config from a synthetic env, a fake dispenser,
// a controllable clock and a captcha stub.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Address, Hex } from 'viem'
import { buildMainnetApp } from '../app.js'
import { loadMainnetConfig, type MainnetAsset, type MainnetConfig } from '../config.js'
import type { Balances, BroadcastResult, MainnetDispenserLike, ReceiptStatus } from '../dispenser.js'
import { MainnetLedger } from '../ledger.js'

// Well-known throwaway key (never funded, never used on any network by us).
// Only used so config validation passes; the fake dispenser never signs.
export const DUMMY_PK = '0x' + '11'.repeat(32)
export const WEI = 10n ** 18n

export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'plmn-'))
  return {
    NETWORK: 'mainnet',
    MAINNET_FAUCET_PK: DUMMY_PK,
    MAINNET_TURNSTILE_SITE_KEY: 'site-key',
    MAINNET_TURNSTILE_SECRET: 'secret',
    MAINNET_DB: ':memory:',
    MAINNET_KILL_FILE: path.join(dir, 'KILL'),
    MAINNET_GLOBAL_RPM: '100000',
    // The shipped default is ON; most tests exercise a live instance.
    MAINNET_KILL_SWITCH: '0',
    ...extra,
  }
}

export class FakeDispenser implements MainnetDispenserLike {
  readonly address: Address = '0x00000000000000000000000000000000000d15e5'
  readonly dryRun = false
  bal: Balances = { fil: 100n * WEI, usdfc: 10_000n * WEI }
  sends: Array<{ asset: MainnetAsset; to: Address; amount: bigint }> = []
  failBeforeBroadcast = false
  /** What waitForReceipt reports. */
  receipt: ReceiptStatus = 'confirmed'
  delayMs = 0
  rpcDown = false
  private n = 0
  async chainId() { return 314 }
  async balances(): Promise<Balances> {
    if (this.rpcDown) throw new Error('rpc down')
    return { ...this.bal }
  }
  async simulate() { return { gas: 21_000n } }
  async broadcast(asset: MainnetAsset, to: Address, amount: bigint): Promise<BroadcastResult> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.failBeforeBroadcast) throw new Error('rpc rejected transaction')
    const h = ('0x' + (++this.n).toString(16).padStart(64, '0')) as Hex
    // Balance only moves once the transfer is included and succeeds.
    if (this.receipt === 'confirmed') this.bal[asset] -= amount
    this.sends.push({ asset, to, amount })
    return { txHash: h, simulated: false, gasEstimate: 21_000n }
  }
  async waitForReceipt(): Promise<ReceiptStatus> {
    return this.receipt
  }
}

export interface Harness {
  cfg: MainnetConfig
  ledger: MainnetLedger
  disp: FakeDispenser
  clock: { t: number }
  alerts: Array<Record<string, unknown>>
  app: Awaited<ReturnType<typeof buildMainnetApp>>['app']
  state: Awaited<ReturnType<typeof buildMainnetApp>>['state']
  drip: (asset: MainnetAsset, address: string, opts?: { ip?: string; token?: string; apiKey?: string; remote?: string }) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>
}

// 2027-01-15T00:00:00Z, mid-month so month rollovers are explicit in tests.
export const T0 = Math.floor(Date.UTC(2027, 0, 15) / 1000)

export async function harness(envExtra: Record<string, string> = {}, disp = new FakeDispenser()): Promise<Harness> {
  const cfg = loadMainnetConfig(baseEnv(envExtra))
  const ledger = new MainnetLedger(cfg.dbPath, { countSimulated: cfg.dryRun })
  const clock = { t: T0 }
  const alerts: Array<Record<string, unknown>> = []
  const { app, state } = await buildMainnetApp({
    cfg,
    ledger,
    dispenser: disp,
    captcha: async (token) => (token === 'good' ? { ok: true } : { ok: false, reason: 'turnstile_invalid-input-response' }),
    now: () => clock.t,
    alertSink: async (p) => { alerts.push(p) },
    logger: false,
  })
  await app.ready()
  const drip: Harness['drip'] = async (asset, address, opts = {}) => {
    const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? '198.51.100.7' }
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey
    const payload: Record<string, string> = { address }
    if (!opts.apiKey || opts.token) payload.turnstileToken = opts.token ?? 'good'
    const res = await app.inject({ method: 'POST', url: `/api/drip/${asset}`, payload, headers, remoteAddress: opts.remote ?? '127.0.0.1' })
    return { status: res.statusCode, body: res.json(), headers: res.headers }
  }
  return { cfg, ledger, disp, clock, alerts, app, state, drip }
}

/** Deterministic distinct 0x address for index i. */
export const addr = (i: number): string => '0x' + (0xa000 + i).toString(16).padStart(40, '0')
