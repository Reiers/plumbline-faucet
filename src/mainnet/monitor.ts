// SPDX-License-Identifier: MIT
//
// Float-reserve and outflow monitoring for the mainnet preview.
//
// MainnetState keeps a short-lived cache of dispenser balances (so a
// Prometheus scrape does not hit the RPC every time), builds the status
// snapshot served at /api/status and /metrics, and raises alerts:
//
//   reserve_breach:<asset>       asset cannot pay a drip (drips refused); not sent while paused
//   reserve_low:<asset>          balance < floor + one drip + headroom
//   monthly_cap_80:<asset>       month-to-date outflow >= 80% of cap
//   monthly_cap_reached:<asset>  month-to-date outflow + one drip > cap
//   kill_switch                  drips paused by the operator
//   rpc_error                    balance read failed
//   abuse_block:<rule>:<value>   an auto-block was written
//
// Alerts are always logged as structured "mainnet_alert" lines. If
// MAINNET_ALERT_WEBHOOK_URL is set they are also POSTed as JSON (the
// body has a "text" field so a Slack or Discord-compatible incoming
// webhook works unchanged). Each alert key repeats at most once per
// MAINNET_ALERT_REPEAT_SEC.

import { existsSync } from 'node:fs'
import { ASSETS, fromMicro, microToWei, weiToMicro, type MainnetAsset, type MainnetConfig } from './config.js'
import type { Balances, MainnetDispenserLike } from './dispenser.js'
import { monthStartUnix, type MainnetLedger } from './ledger.js'

export interface Alert {
  key: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  details?: Record<string, unknown>
}

export interface AlertSink {
  (payload: Record<string, unknown>): Promise<void>
}

export interface Log {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
}

export class Alerter {
  private lastSent = new Map<string, number>()
  readonly active = new Map<string, Alert>()
  constructor(
    private cfg: Pick<MainnetConfig, 'alertWebhookUrl' | 'alertRepeatSec'>,
    private log: Log,
    private now: () => number,
    private sink?: AlertSink,
  ) {}

  /** Raise (or refresh) an alert. Returns true if it was emitted now. */
  async raise(a: Alert, opts: { track?: boolean; once?: boolean } = {}): Promise<boolean> {
    // once: emit only on the transition into this state, never repeat.
    if (opts.once && this.active.has(a.key)) return false
    // Transient alerts (abuse blocks) are sent but not kept in the
    // active list, which is public via /api/status and must not carry
    // client IPs.
    if (opts.track !== false) this.active.set(a.key, a)
    const now = this.now()
    const last = this.lastSent.get(a.key)
    if (last !== undefined && now - last < this.cfg.alertRepeatSec) return false
    this.lastSent.set(a.key, now)
    const payload = {
      source: 'plumbline-faucet-mainnet',
      alert: a.key,
      severity: a.severity,
      message: a.message,
      text: `[plumbline mainnet faucet] ${a.severity.toUpperCase()} ${a.key}: ${a.message}`,
      details: a.details ?? {},
      ts: now,
    }
    this.log.warn(payload, 'mainnet_alert')
    const sink = this.sink ?? (this.cfg.alertWebhookUrl ? webhookSink(this.cfg.alertWebhookUrl) : undefined)
    if (sink) {
      try {
        await sink(payload)
      } catch (err) {
        this.log.error({ err: String(err), alert: a.key }, 'mainnet_alert_webhook_failed')
      }
    }
    return true
  }

  clear(key: string): void {
    if (this.active.delete(key)) this.lastSent.delete(key)
  }
}

export function webhookSink(url: string): AlertSink {
  return async (payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`)
  }
}

export type UnfundedReason = 'preview_unfunded' | 'faucet_dry'

export interface Funding {
  /** null when the balance could not be read. */
  funded: boolean | null
  reason: UnfundedReason | null
  detail: string | null
  /** Balance minus drips broadcast but not confirmed yet. */
  effectiveWei: bigint | null
  /** effective - floor (can be negative). */
  availableWei: bigint | null
  inflightWei: bigint
}

export interface AssetStatus {
  balance: string | null
  balanceWei: string | null
  reserveFloor: string
  perDrip: string
  /** True when at least one drip can be paid without crossing the floor. */
  funded: boolean | null
  unfundedReason: UnfundedReason | null
  /** Amount above the floor (balance minus in-flight minus floor, min 0). */
  available: string | null
  inFlight: string
  /** Not paused, funded, and monthly and daily budget left. */
  acceptingDrips: boolean | null
  /** Same as funded === false (kept for dashboards). */
  reserveBreach: boolean | null
  reserveLow: boolean | null
  monthToDate: string
  monthlyCap: string
  monthlyRemaining: string
  monthlyCapReached: boolean
  last24h: string
  dailyCap: string
  dripsThisMonth: number
}

export class MainnetState {
  private cache: { at: number; balances: Balances } | null = null
  rpcOk = true
  lastRpcError: string | null = null

  constructor(
    private cfg: MainnetConfig,
    private dispenser: MainnetDispenserLike,
    private ledger: MainnetLedger,
    readonly alerter: Alerter,
    private log: Log,
    private now: () => number,
  ) {}

  paused(): boolean {
    return this.cfg.killSwitch || existsSync(this.cfg.killFile)
  }

  /** Balances, served from cache if younger than maxAgeSec. */
  async balances(maxAgeSec = this.cfg.balanceCacheSec): Promise<Balances | null> {
    const now = this.now()
    // maxAgeSec = 0 always forces a fresh read (used right before a send).
    if (this.cache && maxAgeSec > 0 && now - this.cache.at <= maxAgeSec) return this.cache.balances
    try {
      const b = await this.dispenser.balances()
      this.cache = { at: now, balances: b }
      this.rpcOk = true
      this.lastRpcError = null
      this.alerter.clear('rpc_error')
      return b
    } catch (err) {
      this.rpcOk = false
      this.lastRpcError = String(err)
      await this.alerter.raise({ key: 'rpc_error', severity: 'warning', message: 'dispenser balance read failed', details: { error: String(err).slice(0, 300) } })
      return this.cache?.balances ?? null
    }
  }

  invalidate(): void {
    this.cache = null
  }

  /**
   * Can this asset pay one more drip from what is above the floor?
   *   preview_unfunded: nothing above the floor (includes a zero float)
   *   faucet_dry:       something above the floor but less than one drip,
   *                     or (USDFC) no FIL left for gas
   */
  funding(asset: MainnetAsset, b: Balances | null): Funding {
    const p = this.cfg.assets[asset]
    const t = this.now()
    const inflightWei = microToWei(this.ledger.inflightMicro(asset, t))
    if (!b) return { funded: null, reason: null, detail: null, effectiveWei: null, availableWei: null, inflightWei }
    const effectiveWei = b[asset] - inflightWei
    const availableWei = effectiveWei - microToWei(p.reserveFloorMicro)
    const base = { effectiveWei, availableWei, inflightWei }
    if (availableWei <= 0n) {
      return { ...base, funded: false, reason: 'preview_unfunded', detail: `${asset} float is at or below its reserve floor` }
    }
    if (availableWei < microToWei(p.dripMicro)) {
      return { ...base, funded: false, reason: 'faucet_dry', detail: `${asset} float above the floor is less than one drip` }
    }
    if (asset === 'usdfc') {
      const filEff = b.fil - microToWei(this.ledger.inflightMicro('fil', t))
      if (filEff < microToWei(this.cfg.minGasFilMicro)) {
        return { ...base, funded: false, reason: 'faucet_dry', detail: 'no FIL left in the float to pay gas for USDFC transfers' }
      }
    }
    return { ...base, funded: true, reason: null, detail: null }
  }

  monthToDateMicro(asset: MainnetAsset): bigint {
    return this.ledger.sumOutflow({ asset, sinceUnix: monthStartUnix(this.now()) - 1 })
  }

  last24hMicro(asset: MainnetAsset): bigint {
    return this.ledger.sumOutflow({ asset, sinceUnix: this.now() - 86_400 })
  }

  async snapshot(maxAgeSec?: number) {
    const b = await this.balances(maxAgeSec)
    const assets = {} as Record<MainnetAsset, AssetStatus>
    for (const asset of ASSETS) {
      const p = this.cfg.assets[asset]
      const balWei = b ? b[asset] : null
      const balMicro = balWei === null ? null : weiToMicro(balWei)
      const mtd = this.monthToDateMicro(asset)
      const d24 = this.last24hMicro(asset)
      const f = this.funding(asset, b)
      const budgetLeft = mtd + p.dripMicro <= p.monthlyCapMicro && d24 + p.dripMicro <= p.dailyCapMicro
      assets[asset] = {
        balance: balMicro === null ? null : fromMicro(balMicro),
        balanceWei: balWei === null ? null : balWei.toString(),
        reserveFloor: fromMicro(p.reserveFloorMicro),
        perDrip: fromMicro(p.dripMicro),
        funded: f.funded,
        unfundedReason: f.reason,
        available: f.availableWei === null ? null : fromMicro(weiToMicro(f.availableWei > 0n ? f.availableWei : 0n)),
        inFlight: fromMicro(weiToMicro(f.inflightWei)),
        acceptingDrips: f.funded === null ? null : !this.paused() && f.funded && budgetLeft,
        reserveBreach: f.funded === null ? null : !f.funded,
        reserveLow:
          f.effectiveWei === null
            ? null
            : f.effectiveWei < microToWei(p.reserveFloorMicro + p.dripMicro + p.lowReserveHeadroomMicro),
        monthToDate: fromMicro(mtd),
        monthlyCap: fromMicro(p.monthlyCapMicro),
        monthlyRemaining: fromMicro(p.monthlyCapMicro > mtd ? p.monthlyCapMicro - mtd : 0n),
        monthlyCapReached: mtd + p.dripMicro > p.monthlyCapMicro,
        last24h: fromMicro(d24),
        dailyCap: fromMicro(p.dailyCapMicro),
        dripsThisMonth: this.ledger.countedDrips(asset, monthStartUnix(this.now()) - 1),
      }
    }
    return {
      network: 'mainnet' as const,
      chainId: this.cfg.chainId,
      preview: true,
      dispenser: this.dispenser.address,
      dryRun: this.cfg.dryRun,
      paused: this.paused(),
      /** True only when both assets can pay at least one drip. */
      funded: assets.usdfc.funded === null || assets.fil.funded === null ? null : assets.usdfc.funded && assets.fil.funded,
      activated: !this.paused(),
      label: this.paused() ? 'Mainnet preview (not yet activated)' : 'Mainnet preview',
      statusNote: this.cfg.statusNote,
      rpcOk: this.rpcOk,
      balancesAgeSec: this.cache ? this.now() - this.cache.at : null,
      assets,
      abuse: {
        activeBlocks: this.ledger.activeBlockCounts(this.now()),
        blockedAttemptsTotal: this.ledger.counters('refused:blocked')['refused:blocked'] ?? 0,
      },
      alerts: [...this.alerter.active.values()].map((a) => ({ key: a.key, severity: a.severity, message: a.message })),
      generatedAt: this.now(),
    }
  }

  /** Evaluate reserve, cap and kill-switch alerts. Called by the monitor loop and after drips. */
  async evaluateAlerts(maxAgeSec?: number): Promise<void> {
    const snap = await this.snapshot(maxAgeSec)
    if (snap.paused) {
      // Emitted once when drips become paused (the default until a
      // operator activates the preview), not every hour.
      await this.alerter.raise({ key: 'kill_switch', severity: 'info', message: 'mainnet drips are paused (kill switch)' }, { once: true })
    } else {
      this.alerter.clear('kill_switch')
    }
    for (const asset of ASSETS) {
      const s = snap.assets[asset]
      const p = this.cfg.assets[asset]
      // While paused, an empty float is expected (waiting for a
      // activation): show it in status and metrics but do not page anyone.
      if (s.funded === false && !snap.paused) {
        await this.alerter.raise({ key: `reserve_breach:${asset}`, severity: 'critical',
          message: `${asset} cannot pay a drip (${s.unfundedReason}): balance ${s.balance}, floor ${s.reserveFloor}; drips refused, top up the float`,
          details: { balance: s.balance, floor: s.reserveFloor, reason: s.unfundedReason } })
      } else {
        this.alerter.clear(`reserve_breach:${asset}`)
      }
      if (s.reserveLow && s.funded && !snap.paused) {
        await this.alerter.raise({ key: `reserve_low:${asset}`, severity: 'warning',
          message: `${asset} balance ${s.balance} is close to floor ${s.reserveFloor}; top up the float`,
          details: { balance: s.balance, floor: s.reserveFloor } })
      } else {
        this.alerter.clear(`reserve_low:${asset}`)
      }
      const mtd = this.monthToDateMicro(asset)
      if (s.monthlyCapReached) {
        await this.alerter.raise({ key: `monthly_cap_reached:${asset}`, severity: 'warning',
          message: `${asset} monthly cap ${s.monthlyCap} reached (${s.monthToDate} sent this month)` })
      } else {
        this.alerter.clear(`monthly_cap_reached:${asset}`)
      }
      if (mtd * 10n >= p.monthlyCapMicro * 8n && !s.monthlyCapReached) {
        await this.alerter.raise({ key: `monthly_cap_80:${asset}`, severity: 'warning',
          message: `${asset} month-to-date outflow ${s.monthToDate} is at or above 80% of cap ${s.monthlyCap}` })
      } else {
        this.alerter.clear(`monthly_cap_80:${asset}`)
      }
    }
  }

  start(): () => void {
    const tick = () => {
      this.evaluateAlerts(0).catch((err) => this.log.error({ err: String(err) }, 'mainnet monitor tick failed'))
      try {
        this.ledger.prune(this.now())
      } catch (err) {
        this.log.error({ err: String(err) }, 'mainnet prune failed')
      }
    }
    tick()
    const h = setInterval(tick, this.cfg.monitorIntervalSec * 1000)
    h.unref()
    return () => clearInterval(h)
  }
}
