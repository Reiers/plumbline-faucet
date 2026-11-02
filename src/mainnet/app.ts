// SPDX-License-Identifier: MIT
//
// Mainnet preview HTTP app (Fastify). Built from injected dependencies
// so the exact same routes run in production, in unit tests (fake
// dispenser, fake clock) and in the CI binding tests (real mainnet RPC,
// dry-run dispenser).
//
// Routes (served at the instance root; nginx maps /mainnet/ to it):
//   GET  /                 mainnet preview page (public-mainnet/index.html)
//   GET  /healthz          liveness, no RPC call
//   GET  /api/info         network, token, dispenser, full cap policy
//   GET  /api/status       float reserve, month-to-date outflow vs cap,
//                          abuse counters, active alerts
//   GET  /api/check?address=0x...   remaining allowance for an address
//   GET  /api/recent       last drips (address, amount, tx)
//   GET  /metrics          Prometheus text format
//   POST /api/drip/usdfc   { address, turnstileToken } or API key
//   POST /api/drip/fil     { address, turnstileToken } or API key
//
// There is deliberately no anonymous no-captcha route on mainnet.
//
// Order of checks for a drip:
//   kill switch -> body -> recipient -> API key -> active blocks ->
//   record attempt -> captcha (unless API key) -> abuse rules ->
//   queue limit -> [serialised] monthly cap -> daily cap -> address cap
//   -> API key cap or IP + subnet caps -> reserve floor -> ledger row
//   (pending) -> simulate + send -> ledger row final status.
// Caps and reserve are evaluated inside a single-flight queue so
// concurrent requests cannot overshoot a cap.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import rateLimitPlugin from '@fastify/rate-limit'
import staticPlugin from '@fastify/static'
import { z } from 'zod'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Address, Hex } from 'viem'

import { classifyRecipient } from '../fil-address.js'
import { findBlock, evaluateAbuse } from './abuse.js'
import type { CaptchaVerifier } from './captcha.js'
import {
  ASSETS,
  fromMicro,
  microToWei,
  publicPolicy,
  weiToMicro,
  USDFC_DECIMALS,
  type MainnetAsset,
  type MainnetConfig,
} from './config.js'
import type { MainnetDispenserLike } from './dispenser.js'
import { monthStartUnix, nextMonthStartUnix, type MainnetApiKey, type MainnetLedger } from './ledger.js'
import { Alerter, MainnetState, type AlertSink, type Log } from './monitor.js'
import { normalizeIp, subnetOf } from './net.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXPLORER_TX = 'https://filecoin.blockscout.com/tx/'

export interface MainnetDeps {
  cfg: MainnetConfig
  ledger: MainnetLedger
  dispenser: MainnetDispenserLike
  captcha: CaptchaVerifier
  /** Unix seconds. Injected for tests. */
  now?: () => number
  alertSink?: AlertSink
  logger?: boolean | { level: string }
}

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  depth = 0
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++
    const p = this.tail.then(fn)
    this.tail = p.then(
      () => undefined,
      () => undefined,
    )
    return p.finally(() => {
      this.depth--
    })
  }
}

type Refusal = { code: number; body: Record<string, unknown> }

export type ParsedRecipient =
  | { ok: true; address: Address; original: string }
  | { ok: false; error: string; reason: string }

/** Mainnet accepts 0x and f410f recipients only. */
export function parseMainnetRecipient(input: string): ParsedRecipient {
  const s = input.trim()
  if (/^t[0-4]/i.test(s)) {
    return { ok: false, error: 'testnet_address', reason: 'This is a testnet (t...) address. Mainnet uses 0x or f410f addresses.' }
  }
  const r = classifyRecipient(s)
  if (r.kind === 'invalid') return { ok: false, error: 'invalid_address', reason: r.reason }
  if (r.kind === 'filecoin') {
    return {
      ok: false,
      error: 'native_address_unsupported',
      reason: 'The mainnet preview sends to 0x or f410f addresses only. f0/f1/f2/f3 recipients are not supported.',
    }
  }
  return { ok: true, address: r.address.toLowerCase() as Address, original: s }
}

export async function buildMainnetApp(deps: MainnetDeps): Promise<{ app: FastifyInstance; state: MainnetState }> {
  const { cfg, ledger, dispenser, captcha } = deps
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))

  const app = Fastify({
    logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: cfg.trustProxy.split(',').map((s) => s.trim()).filter(Boolean),
  })
  const log: Log = {
    info: (o, m) => app.log.info(o, m),
    warn: (o, m) => app.log.warn(o, m),
    error: (o, m) => app.log.error(o, m),
  }
  const alerter = new Alerter(cfg, log, now, deps.alertSink)
  const state = new MainnetState(cfg, dispenser, ledger, alerter, log, now)
  const queue = new SerialQueue()

  await app.register(cors, { origin: true })
  await app.register(rateLimitPlugin, {
    max: cfg.globalRequestsPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (req) => normalizeIp(req.ip),
  })
  await app.register(staticPlugin, {
    root: path.join(__dirname, '..', '..', 'public-mainnet'),
    prefix: '/',
    decorateReply: false,
  })
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-plumbline-network', 'mainnet')
    return payload
  })

  const extractApiKey = (req: FastifyRequest): string | null => {
    const h = req.headers['x-api-key']
    if (typeof h === 'string' && h.trim() !== '') return h.trim()
    const auth = req.headers['authorization']
    if (typeof auth === 'string') {
      const m = auth.match(/^\s*Bearer\s+(\S+)\s*$/i)
      if (m) return m[1]!
    }
    return null
  }

  const human = (wei: bigint) => fromMicro(weiToMicro(wei))
  const statusNote = cfg.statusNote

  // ─── Read-only endpoints ──────────────────────────────────────────

  app.get('/healthz', async () => ({
    ok: true,
    network: 'mainnet',
    chainId: cfg.chainId,
    dispenser: dispenser.address,
    paused: state.paused(),
    dryRun: cfg.dryRun,
    rpcOk: state.rpcOk,
  }))

  app.get('/api/info', async () => ({
    network: 'mainnet',
    preview: true,
    chainId: cfg.chainId,
    paused: state.paused(),
    dryRun: cfg.dryRun,
    dispenser: dispenser.address,
    usdfc: { address: cfg.usdfcAddress, symbol: 'USDFC', decimals: USDFC_DECIMALS },
    recipients: ['0x', 'f410f'],
    captcha: { provider: 'turnstile', siteKey: cfg.turnstileSiteKey, action: cfg.turnstileAction || null },
    activated: !state.paused(),
    label: state.paused() ? 'Mainnet preview (not yet activated)' : 'Mainnet preview',
    statusNote,
    fundingModel: 'The float is loaded by the operator at activation. Maximum outflow per month is the global monthly cap per asset.',
    apiKeys: 'Named integrators only. Send X-API-Key or Authorization: Bearer. Keys have their own caps.',
    policy: publicPolicy(cfg),
    endpoints: {
      dripUsdfc: 'POST api/drip/usdfc',
      dripFil: 'POST api/drip/fil',
      status: 'GET api/status',
      check: 'GET api/check?address=0x...',
      metrics: 'GET metrics',
    },
  }))

  app.get('/api/status', async () => state.snapshot())

  app.get('/api/recent', async (req) => {
    const limit = Math.min(50, Math.max(1, Number((req.query as { limit?: string }).limit ?? 10) || 10))
    return {
      drips: ledger.recent(limit).map((r) => ({
        unix: r.ts,
        asset: r.asset,
        address: r.address,
        amount: fromMicro(r.amountMicro),
        status: r.status,
        txHash: r.txHash,
      })),
    }
  })

  app.get('/api/check', async (req, reply) => {
    const raw = String((req.query as { address?: string }).address ?? '')
    const r = parseMainnetRecipient(raw)
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error, reason: r.reason })
    const t = now()
    const out: Record<string, unknown> = {}
    for (const asset of ASSETS) {
      const p = cfg.assets[asset]
      const f = { asset, sinceUnix: t - cfg.addressWindowSec, address: r.address }
      const used = ledger.sumOutflow(f)
      const oldest = ledger.oldestInWindow(f)
      const eligible = used + p.dripMicro <= p.addressCapMicro
      out[asset] = {
        usedInWindow: fromMicro(used),
        cap: fromMicro(p.addressCapMicro),
        remaining: fromMicro(p.addressCapMicro > used ? p.addressCapMicro - used : 0n),
        eligibleNow: eligible,
        nextEligibleUnix: eligible ? t : oldest !== null ? oldest + cfg.addressWindowSec + 1 : t,
      }
    }
    return { ok: true, address: r.address, windowSec: cfg.addressWindowSec, ...out }
  })

  app.get('/metrics', async (_req, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8')
    const snap = await state.snapshot()
    const lines: string[] = []
    const metric = (name: string, help: string, type: 'gauge' | 'counter', samples: Array<[string, string | number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
      for (const [labels, v] of samples) lines.push(`${name}${labels} ${v}`)
    }
    const perAsset = (fn: (a: MainnetAsset) => string | number) =>
      ASSETS.map((a) => [`{asset="${a}"}`, fn(a)] as [string, string | number])
    const counters = ledger.counters()
    const pick = (prefix: string, label: string) =>
      Object.entries(counters)
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [`{${label}="${k.slice(prefix.length)}"}`, v] as [string, number])

    metric('plumbline_mainnet_up', 'Mainnet preview faucet is up.', 'gauge', [['', 1]])
    metric('plumbline_mainnet_paused', '1 when the kill switch is on.', 'gauge', [['', snap.paused ? 1 : 0]])
    metric('plumbline_mainnet_dry_run', '1 when sends are simulated only.', 'gauge', [['', cfg.dryRun ? 1 : 0]])
    metric('plumbline_mainnet_rpc_ok', '1 when the last balance read succeeded.', 'gauge', [['', snap.rpcOk ? 1 : 0]])
    metric('plumbline_mainnet_dispenser_balance_wei', 'Dispenser balance, 18-decimal base units.', 'gauge',
      perAsset((a) => snap.assets[a].balanceWei ?? 'NaN'))
    metric('plumbline_mainnet_reserve_floor_wei', 'Configured float reserve floor.', 'gauge',
      perAsset((a) => microToWei(cfg.assets[a].reserveFloorMicro).toString()))
    metric('plumbline_mainnet_funded', '1 when the float can pay at least one drip above the floor.', 'gauge',
      perAsset((a) => (snap.assets[a].funded === null ? 'NaN' : snap.assets[a].funded ? 1 : 0)))
    metric('plumbline_mainnet_accepting_drips', '1 when not paused, funded, and budget left.', 'gauge',
      perAsset((a) => (snap.assets[a].acceptingDrips === null ? 'NaN' : snap.assets[a].acceptingDrips ? 1 : 0)))
    metric('plumbline_mainnet_inflight_wei', 'Drips broadcast but not confirmed yet.', 'gauge',
      perAsset((a) => microToWei(ledger.inflightMicro(a, now())).toString()))
    metric('plumbline_mainnet_reserve_breach', '1 when drips are refused for the float (same as funded == 0).', 'gauge',
      perAsset((a) => (snap.assets[a].reserveBreach === null ? 'NaN' : snap.assets[a].reserveBreach ? 1 : 0)))
    metric('plumbline_mainnet_reserve_low', '1 when balance < floor + one drip + headroom.', 'gauge',
      perAsset((a) => (snap.assets[a].reserveLow === null ? 'NaN' : snap.assets[a].reserveLow ? 1 : 0)))
    metric('plumbline_mainnet_outflow_month_wei', 'Outflow this calendar month (UTC).', 'gauge',
      perAsset((a) => microToWei(state.monthToDateMicro(a)).toString()))
    metric('plumbline_mainnet_outflow_month_cap_wei', 'Hard monthly outflow cap.', 'gauge',
      perAsset((a) => microToWei(cfg.assets[a].monthlyCapMicro).toString()))
    metric('plumbline_mainnet_outflow_24h_wei', 'Outflow over the last 24h.', 'gauge',
      perAsset((a) => microToWei(state.last24hMicro(a)).toString()))
    metric('plumbline_mainnet_outflow_24h_cap_wei', 'Rolling 24h outflow cap.', 'gauge',
      perAsset((a) => microToWei(cfg.assets[a].dailyCapMicro).toString()))
    metric('plumbline_mainnet_drips_total', 'Successful drips by asset (confirmed, pending receipt, or simulated in dry run).', 'counter',
      perAsset((a) => counters[`drip:${a}`] ?? 0))
    metric('plumbline_mainnet_refused_total', 'Refused drip requests by reason.', 'counter', pick('refused:', 'reason'))
    metric('plumbline_mainnet_blocked_attempts_total', 'Requests refused because of an active block.', 'counter',
      [['', counters['refused:blocked'] ?? 0]])
    metric('plumbline_mainnet_abuse_trips_total', 'Abuse rule trips by rule.', 'counter', pick('abuse_trip:', 'rule'))
    metric('plumbline_mainnet_active_blocks', 'Active blocks by kind.', 'gauge',
      (['ip', 'subnet', 'address'] as const).map((k) => [`{kind="${k}"}`, snap.abuse.activeBlocks[k]] as [string, number]))
    metric('plumbline_mainnet_queue_depth', 'Drips waiting or in flight.', 'gauge', [['', queue.depth]])
    metric('plumbline_mainnet_scrape_timestamp_seconds', 'Unix time of this scrape.', 'gauge', [['', now()]])
    return lines.join('\n') + '\n'
  })

  // ─── Drip ─────────────────────────────────────────────────────────

  const dripBody = z.object({
    address: z.string().min(3).max(120),
    turnstileToken: z.string().max(4096).optional(),
  })

  const capRefusal = (asset: MainnetAsset, address: string, ip: string, subnet: string, key: MainnetApiKey | null, t: number): Refusal | null => {
    const p = cfg.assets[asset]
    const drip = p.dripMicro
    const retryAfter = (oldest: number | null, windowSec: number) => (oldest === null ? windowSec : Math.max(1, oldest + windowSec - t + 1))

    const mtd = ledger.sumOutflow({ asset, sinceUnix: monthStartUnix(t) - 1 })
    if (mtd + drip > p.monthlyCapMicro) {
      const retryAt = nextMonthStartUnix(t)
      return { code: 503, body: { error: 'monthly_cap_reached', scope: 'global_month',
        reason: `The global monthly ${asset} budget for the mainnet preview is used up.`,
        used: fromMicro(mtd), cap: fromMicro(p.monthlyCapMicro), retryAfterSec: retryAt - t, retryAtUnix: retryAt } }
    }
    const dayF = { asset, sinceUnix: t - 86_400 }
    const d24 = ledger.sumOutflow(dayF)
    if (d24 + drip > p.dailyCapMicro) {
      const ra = retryAfter(ledger.oldestInWindow(dayF), 86_400)
      return { code: 503, body: { error: 'daily_cap_reached', scope: 'global_24h',
        reason: `The global 24h ${asset} budget is used up.`,
        used: fromMicro(d24), cap: fromMicro(p.dailyCapMicro), retryAfterSec: ra, retryAtUnix: t + ra } }
    }
    const addrF = { asset, sinceUnix: t - cfg.addressWindowSec, address }
    const used = ledger.sumOutflow(addrF)
    if (used + drip > p.addressCapMicro) {
      const ra = retryAfter(ledger.oldestInWindow(addrF), cfg.addressWindowSec)
      return { code: 429, body: { error: 'address_cap', scope: 'address',
        used: fromMicro(used), cap: fromMicro(p.addressCapMicro), windowSec: cfg.addressWindowSec, retryAfterSec: ra, retryAtUnix: t + ra } }
    }
    if (key) {
      const kcap = asset === 'usdfc' ? key.capUsdfcMicro : key.capFilMicro
      const kF = { asset, sinceUnix: t - key.windowSec, apiKeyId: key.id }
      const kUsed = ledger.sumOutflow(kF)
      if (kUsed + drip > kcap) {
        const ra = retryAfter(ledger.oldestInWindow(kF), key.windowSec)
        return { code: 429, body: { error: 'api_key_cap', scope: 'api_key',
          used: fromMicro(kUsed), cap: fromMicro(kcap), windowSec: key.windowSec, retryAfterSec: ra, retryAtUnix: t + ra } }
      }
      return null
    }
    const ipF = { asset, sinceUnix: t - cfg.ipWindowSec, ip, apiKeyId: null }
    const ipUsed = ledger.sumOutflow(ipF)
    if (ipUsed + drip > p.ipCapMicro) {
      const ra = retryAfter(ledger.oldestInWindow(ipF), cfg.ipWindowSec)
      return { code: 429, body: { error: 'ip_cap', scope: 'ip',
        used: fromMicro(ipUsed), cap: fromMicro(p.ipCapMicro), windowSec: cfg.ipWindowSec, retryAfterSec: ra, retryAtUnix: t + ra } }
    }
    const subF = { asset, sinceUnix: t - cfg.ipWindowSec, subnet, apiKeyId: null }
    const subUsed = ledger.sumOutflow(subF)
    if (subUsed + drip > p.subnetCapMicro) {
      const ra = retryAfter(ledger.oldestInWindow(subF), cfg.ipWindowSec)
      return { code: 429, body: { error: 'subnet_cap', scope: 'subnet',
        used: fromMicro(subUsed), cap: fromMicro(p.subnetCapMicro), windowSec: cfg.ipWindowSec, retryAfterSec: ra, retryAtUnix: t + ra } }
    }
    return null
  }

  const handleDrip = async (asset: MainnetAsset, req: FastifyRequest, reply: FastifyReply) => {
    const t = now()
    const ip = normalizeIp(req.ip)
    const subnet = subnetOf(ip)
    let eventId: number | null = null
    let apiKey: MainnetApiKey | null = null
    let recipientForLog: string | null = null

    const refuse = (code: number, body: Record<string, unknown>) => {
      const error = String(body.error)
      ledger.inc(`refused:${error}`)
      if (eventId !== null) ledger.updateEvent(eventId, { outcome: 'refused', reason: error })
      if (typeof body.retryAfterSec === 'number') reply.header('retry-after', String(body.retryAfterSec))
      app.log.info({ event: 'mainnet_refused', asset, error, ip, recipient: recipientForLog, apiKey: apiKey?.name ?? null }, 'mainnet drip refused')
      return reply.code(code).send({ ok: false, network: 'mainnet', asset, ...body })
    }

    if (state.paused()) {
      return refuse(503, {
        error: 'mainnet_paused',
        reason: 'Mainnet preview (not yet activated). Drips are disabled until the operator loads the float and turns them on.',
        statusNote,
      })
    }
    const parsed = dripBody.safeParse(req.body)
    if (!parsed.success) return refuse(400, { error: 'bad_request', reason: 'expected JSON { address, turnstileToken }' })

    const r = parseMainnetRecipient(parsed.data.address)
    if (!r.ok) return refuse(400, { error: r.error, reason: r.reason })
    const to = r.address
    recipientForLog = to
    if (
      to === '0x0000000000000000000000000000000000000000' ||
      to === dispenser.address.toLowerCase() ||
      to === cfg.usdfcAddress.toLowerCase()
    ) {
      return refuse(400, { error: 'recipient_not_allowed', reason: 'This recipient cannot receive faucet drips.' })
    }

    const presented = extractApiKey(req)
    if (presented !== null) {
      const k = ledger.findApiKey(presented)
      if (!k) return refuse(401, { error: 'invalid_api_key', reason: 'API key is not recognised' })
      if (!k.enabled) return refuse(401, { error: 'revoked_api_key', reason: 'API key has been revoked' })
      apiKey = k
    }
    const viaApiKey = apiKey !== null
    const ctx = { ip, subnet, address: to, nowUnix: t, viaApiKey }

    const existing = findBlock(ledger, ctx)
    if (existing) {
      ledger.recordEvent({ ts: t, ip, subnet, address: to, asset, outcome: 'refused', reason: 'blocked', verified: false, apiKeyId: apiKey?.id ?? null })
      return refuse(403, { error: 'blocked', scope: existing.kind, untilUnix: existing.untilUnix,
        reason: `Blocked by abuse protection (${existing.kind}). Contact the operator if this is a mistake.` })
    }

    eventId = ledger.recordEvent({ ts: t, ip, subnet, address: to, asset, outcome: 'attempt', reason: null, verified: viaApiKey, apiKeyId: apiKey?.id ?? null })

    if (!viaApiKey) {
      const c = await captcha(parsed.data.turnstileToken ?? '', ip)
      if (!c.ok) {
        ledger.updateEvent(eventId, { outcome: 'refused', reason: 'captcha' })
        const trips = evaluateAbuse(ledger, cfg.abuse, ctx)
        await reportTrips(trips)
        const res = refuse(400, { error: 'captcha', reason: c.reason })
        return res
      }
      ledger.updateEvent(eventId, { verified: true })
    }

    const trips = evaluateAbuse(ledger, cfg.abuse, ctx)
    await reportTrips(trips)
    const nowBlocked = findBlock(ledger, ctx)
    if (nowBlocked) {
      return refuse(403, { error: 'blocked', scope: nowBlocked.kind, untilUnix: nowBlocked.untilUnix,
        reason: `Blocked by abuse protection (${nowBlocked.kind}). Contact the operator if this is a mistake.` })
    }

    if (queue.depth >= cfg.maxQueue) {
      return refuse(503, { error: 'busy', reason: 'Too many drips in flight. Retry in a minute.', retryAfterSec: 60 })
    }

    // Single-flight section: caps, reserve and broadcast. Held only
    // until the transaction is broadcast (a few seconds), not for the
    // receipt, so queued callers stay well inside proxy timeouts.
    type Sent =
      | { kind: 'refused'; reply: FastifyReply }
      | { kind: 'sent'; rowId: number; txHash: Hex | null; simulated: boolean; gas: bigint }
    const sent: Sent = await queue.run(async (): Promise<Sent> => {
      const tt = now()
      const capped = capRefusal(asset, to, ip, subnet, apiKey, tt)
      if (capped) return { kind: 'refused', reply: refuse(capped.code, capped.body) }

      const p = cfg.assets[asset]
      const amountWei = microToWei(p.dripMicro)
      const b = await state.balances(0)
      if (!b) {
        return { kind: 'refused', reply: refuse(503, { error: 'rpc_unavailable', reason: 'Could not read dispenser balance. Retry later.', retryAfterSec: 60 }) }
      }
      // Float check. Works with any float, including zero. In-flight
      // drips (broadcast, not confirmed) are subtracted from the balance.
      const f = state.funding(asset, b)
      if (!f.funded) {
        void state.evaluateAlerts().catch(() => undefined)
        return {
          kind: 'refused',
          reply: refuse(503, {
            error: f.reason ?? 'faucet_dry',
            reason:
              f.reason === 'preview_unfunded'
                ? `The mainnet preview ${asset} float is not funded right now (${f.detail}).`
                : `The mainnet preview is out of ${asset} for now (${f.detail}).`,
            funded: false,
            balance: human(b[asset]),
            available: human(f.availableWei !== null && f.availableWei > 0n ? f.availableWei : 0n),
            floor: fromMicro(p.reserveFloorMicro),
            statusNote,
          }),
        }
      }

      const rowId = ledger.insertPending({ ts: tt, asset, address: to, ip, subnet, apiKeyId: apiKey?.id ?? null, amountMicro: p.dripMicro })
      try {
        const res = await dispenser.broadcast(asset, to, amountWei)
        ledger.setStatus(rowId, res.simulated ? 'simulated' : 'sent', { txHash: res.txHash })
        return { kind: 'sent', rowId, txHash: res.txHash, simulated: res.simulated, gas: res.gasEstimate }
      } catch (err) {
        // Nothing was broadcast: release the reservation.
        ledger.setStatus(rowId, 'failed', { error: String(err).slice(0, 500) })
        app.log.error({ event: 'mainnet_drip_failed', asset, recipient: to, ip, err: String(err) }, 'mainnet drip failed')
        ledger.inc('refused:drip_failed')
        if (eventId !== null) ledger.updateEvent(eventId, { outcome: 'error', reason: 'drip_failed' })
        return {
          kind: 'refused',
          reply: reply.code(500).send({ ok: false, network: 'mainnet', asset, error: 'drip_failed', reason: String(err).slice(0, 300) }),
        }
      }
    })
    if (sent.kind === 'refused') return sent.reply

    const p = cfg.assets[asset]
    let status: 'simulated' | 'confirmed' | 'reverted' | 'submitted' = 'simulated'
    if (sent.txHash) {
      const r = await dispenser.waitForReceipt(sent.txHash, cfg.receiptTimeoutMs)
      if (r === 'pending') {
        status = 'submitted'
        // Keep watching in the background so the ledger ends up final.
        const hash = sent.txHash
        void dispenser.waitForReceipt(hash, 15 * 60_000).then((late) => {
          if (late === 'confirmed') ledger.setStatus(sent.rowId, 'confirmed')
          if (late === 'reverted') {
            ledger.setStatus(sent.rowId, 'reverted')
            ledger.inc(`reverted:${asset}`)
          }
          state.invalidate()
        })
      } else {
        status = r
        ledger.setStatus(sent.rowId, r)
      }
    }
    state.invalidate()

    if (status === 'reverted') {
      ledger.inc(`reverted:${asset}`)
      if (eventId !== null) ledger.updateEvent(eventId, { outcome: 'error', reason: 'drip_reverted' })
      app.log.error({ event: 'mainnet_drip_reverted', asset, recipient: to, txHash: sent.txHash }, 'mainnet drip reverted')
      return reply.code(500).send({ ok: false, network: 'mainnet', asset, error: 'drip_reverted', txHash: sent.txHash,
        reason: 'The transaction was included but reverted. It does not count against your cap.' })
    }

    ledger.inc(`drip:${asset}`)
    if (eventId !== null) ledger.updateEvent(eventId, { outcome: 'ok' })
    app.log.info({ event: 'mainnet_drip', asset, recipient: to, ip, apiKey: apiKey?.name ?? null, txHash: sent.txHash, status, amount: fromMicro(p.dripMicro) }, 'mainnet drip ok')
    void state.evaluateAlerts().catch(() => undefined)
    return reply.code(status === 'submitted' ? 202 : 200).send({
      ok: true,
      network: 'mainnet',
      asset,
      amount: fromMicro(p.dripMicro),
      to,
      status,
      txHash: sent.txHash,
      explorerUrl: sent.txHash ? EXPLORER_TX + sent.txHash : null,
      dryRun: cfg.dryRun,
      gasEstimate: sent.gas.toString(),
      note:
        status === 'submitted'
          ? 'Broadcast; the receipt was not seen yet. Check the explorer link.'
          : status === 'simulated'
            ? 'Dry run: simulated against mainnet, nothing was sent.'
            : undefined,
    })
  }

  const reportTrips = async (trips: ReturnType<typeof evaluateAbuse>) => {
    for (const tr of trips) {
      app.log.warn({ event: 'mainnet_abuse_trip', ...tr }, 'mainnet abuse rule tripped')
      if (tr.blocked) {
        await alerter.raise({ key: `abuse_block:${tr.rule}:${tr.value}`, severity: 'warning',
          message: `auto-blocked ${tr.kind} ${tr.value} (${tr.rule}: ${tr.observed} > ${tr.threshold})` }, { track: false })
      }
    }
  }

  app.post('/api/drip/usdfc', (req, reply) => handleDrip('usdfc', req, reply))
  app.post('/api/drip/fil', (req, reply) => handleDrip('fil', req, reply))

  return { app, state }
}
