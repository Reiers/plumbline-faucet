// SPDX-License-Identifier: MIT
//
// Plumbline builder API v1.
//
// A stable, versioned, read-only JSON surface for tooling, plus
// documented aliases for the existing drip handlers. Everything lives
// under /api/v1 and every response carries apiVersion: "1".
//
//   GET  /api/v1                 index of endpoints
//   GET  /api/v1/faucet/status   dispenser health, balances, reserves, limits
//   GET  /api/v1/faucet/drips    recent drips (paginated)
//   GET  /api/v1/network         calibration health (from Calix, cached)
//   GET  /api/v1/sp              SP test-target status (from Calix, cached)
//   GET  /api/v1/openapi.json    OpenAPI 3.1 description of this API
//   POST /api/v1/drip/fil        alias of POST /api/drip/fil
//   POST /api/v1/drip/usdfc      alias of POST /api/drip/usdfc
//
// Compatibility rules for v1: fields may be added, never removed or
// renamed, and the meaning of an existing field does not change. A
// breaking change ships as /api/v2.
//
// The drip aliases call the exact same handler as the legacy routes, so
// captcha, API-key auth, per-IP, per-address and per-key limits are
// shared and identical. The per-IP GET budget below applies only to the
// read endpoints.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { formatEther, formatUnits, parseEther, parseUnits } from 'viem'

import type { FaucetConfig } from './config.js'
import type { DispenserState } from './drip.js'
import { RECENT_DRIPS_RETENTION, type StatsStore } from './stats-store.js'
import { UpstreamCache, UpstreamError, fetchJson, type CachedResult } from './upstream-cache.js'
import { buildOpenApi } from './openapi.js'

export const API_VERSION = '1'
const USDFC_DECIMALS = 18
const CALIBRATION_CHAIN_ID = 314159

type Asset = 'fil' | 'usdfc'
type TrafficLight = 'ok' | 'watch' | 'bad'

export interface ApiV1Deps {
  cfg: FaucetConfig
  stats: StatsStore
  dispenserAddress: string
  getDispenserState: () => Promise<DispenserState>
  handleDrip: (asset: Asset, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
  fetchImpl?: typeof fetch
}

// ─── Error envelope ─────────────────────────────────────────────────
//
// { apiVersion: "1", ok: false, error: "<machine_code>", message: "<human>", ...details }

export function errorBody(
  error: string,
  message: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return { apiVersion: API_VERSION, ok: false, error, message, ...details }
}

// ─── Per-IP fixed-window limiter for GET ────────────────────────────

export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()
  private lastSweep = 0

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; remaining: number; resetSec: number } {
    const now = this.now()
    if (now - this.lastSweep > this.windowMs) this.sweep(now)
    let rec = this.hits.get(key)
    if (!rec || now >= rec.resetAt) {
      rec = { count: 0, resetAt: now + this.windowMs }
      this.hits.set(key, rec)
    }
    rec.count += 1
    const resetSec = Math.max(1, Math.ceil((rec.resetAt - now) / 1000))
    return {
      allowed: rec.count <= this.max,
      remaining: Math.max(0, this.max - rec.count),
      resetSec,
    }
  }

  private sweep(now: number): void {
    this.lastSweep = now
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const iso = (ms: number): string => new Date(ms).toISOString()

function parseIntParam(
  raw: unknown,
  name: string,
  def: number,
  min: number,
  max: number,
): number | { error: string } {
  if (raw === undefined || raw === '') return def
  const s = String(raw)
  if (!/^\d+$/.test(s)) return { error: name + ' must be an integer between ' + min + ' and ' + max }
  const n = Number(s)
  if (n < min || n > max) return { error: name + ' must be an integer between ' + min + ' and ' + max }
  return n
}

function signal(v: unknown): { value: number | null; unit: string | null; status: string | null } | null {
  const o = obj(v)
  if (Object.keys(o).length === 0) return null
  return { value: num(o.value), unit: str(o.unit), status: str(o.status) }
}

// ─── Plugin ─────────────────────────────────────────────────────────

export async function registerApiV1(app: FastifyInstance, deps: ApiV1Deps): Promise<void> {
  const { cfg, stats } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  const limiter = new FixedWindowLimiter(cfg.API_V1_GET_RATE_LIMIT, 60_000)

  const calixSource = (endpoints: string[]) => ({
    name: 'calix',
    url: cfg.CALIX_PUBLIC_URL,
    endpoints,
  })
  const NETWORK_ENDPOINTS = ['/api/v1/status', '/api/v1/signals']
  const spPath = '/api/v1/miners/status?addrs=' + encodeURIComponent(cfg.SP_TARGETS.join(','))

  const cacheOpts = {
    ttlMs: cfg.UPSTREAM_CACHE_SEC * 1000,
    staleMaxMs: cfg.UPSTREAM_STALE_MAX_SEC * 1000,
  }
  const networkCache = new UpstreamCache(async () => {
    const [status, signals] = await Promise.all([
      fetchJson(cfg.CALIX_URL + '/api/v1/status', cfg.UPSTREAM_TIMEOUT_MS, fetchImpl),
      fetchJson(cfg.CALIX_URL + '/api/v1/signals', cfg.UPSTREAM_TIMEOUT_MS, fetchImpl),
    ])
    return { status: obj(status), signals: obj(signals) }
  }, cacheOpts)
  const spCache = new UpstreamCache(
    async () => obj(await fetchJson(cfg.CALIX_URL + spPath, cfg.UPSTREAM_TIMEOUT_MS, fetchImpl)),
    cacheOpts,
  )
  const dispenserCache = new UpstreamCache(() => deps.getDispenserState(), {
    ttlMs: cfg.FAUCET_STATUS_CACHE_SEC * 1000,
    staleMaxMs: 120_000,
  })

  const freshness = (c: CachedResult<unknown>) => {
    const out: Record<string, unknown> = {
      fetchedAt: iso(c.fetchedAt),
      cacheAgeSec: c.cacheAgeSec,
      stale: c.stale,
    }
    if (c.upstreamError) out.upstreamError = c.upstreamError
    return out
  }

  await app.register(
    async (v1) => {
      // CORS: open to any origin. Set on every v1 response, overriding the
      // reflected origin the global CORS plugin would set.
      v1.addHook('onRequest', async (req, reply) => {
        reply.header('access-control-allow-origin', '*')
        reply.header('x-api-version', API_VERSION)
        reply.header(
          'access-control-expose-headers',
          'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Policy, Retry-After, X-API-Version',
        )
        if (req.method !== 'GET' && req.method !== 'HEAD') return
        const r = limiter.hit(req.ip)
        reply.header('ratelimit-limit', String(limiter.max))
        reply.header('ratelimit-remaining', String(r.remaining))
        reply.header('ratelimit-reset', String(r.resetSec))
        reply.header('ratelimit-policy', limiter.max + ';w=60')
        if (!r.allowed) {
          reply.header('retry-after', String(r.resetSec))
          return reply
            .code(429)
            .send(
              errorBody('rate_limited', 'Too many requests. Retry after ' + r.resetSec + 's.', {
                limit: limiter.max,
                windowSec: 60,
                retryAfterSec: r.resetSec,
              }),
            )
        }
      })

      // Normalise every JSON body: apiVersion on top, and error bodies
      // from the shared drip handler get a human message field.
      v1.addHook('onSend', async (req, reply, payload) => {
        reply.header('access-control-allow-origin', '*')
        if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store')
        const ct = String(reply.getHeader('content-type') ?? '')
        if (typeof payload !== 'string' || !ct.includes('json')) return payload
        // The OpenAPI document must stay a valid OpenAPI object; it carries
        // x-apiVersion plus the X-API-Version header instead.
        if (reply.statusCode === 200 && req.url.split('?')[0].endsWith('/openapi.json')) return payload
        let body: unknown
        try {
          body = JSON.parse(payload)
        } catch {
          return payload
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return payload
        const o = body as Record<string, unknown>
        if (o.apiVersion === API_VERSION && (o.ok !== false || typeof o.message === 'string')) {
          return payload
        }
        const { apiVersion: _ignored, ...rest } = o
        void _ignored
        const out: Record<string, unknown> = { apiVersion: API_VERSION, ...rest }
        if (out.ok === false && typeof out.message !== 'string') {
          out.message = typeof out.reason === 'string' ? out.reason : String(out.error ?? 'error')
        }
        return JSON.stringify(out)
      })

      v1.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
        const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500
        let code = 'internal_error'
        if (status === 429) code = 'rate_limited'
        else if (status === 404) code = 'not_found'
        else if (status === 413) code = 'payload_too_large'
        else if (status === 415) code = 'unsupported_media_type'
        else if (status >= 400 && status < 500) code = 'bad_request'
        if (status >= 500) req.log.error({ err }, 'api v1 error')
        const message = status >= 500 ? 'Internal error' : err.message || code
        reply.code(status).send(errorBody(code, message))
      })

      v1.setNotFoundHandler((req, reply) => {
        reply.code(404).send(errorBody('not_found', 'No such endpoint: ' + req.method + ' ' + req.url.split('?')[0]))
      })

      // ─── Index ────────────────────────────────────────────────────
      v1.get('/', async () => ({
        apiVersion: API_VERSION,
        ok: true,
        name: 'Plumbline builder API',
        network: 'calibration',
        docs: 'https://github.com/Reiers/plumbline-faucet/blob/main/docs/api.md',
        openapi: '/api/v1/openapi.json',
        stability:
          'v1 is stable: fields may be added but are never removed or renamed. Breaking changes ship as /api/v2.',
        rateLimit: {
          readPerIpPerMinute: limiter.max,
          headers: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'RateLimit-Policy'],
        },
        endpoints: [
          { method: 'GET', path: '/api/v1', description: 'This index.' },
          { method: 'GET', path: '/api/v1/faucet/status', description: 'Dispenser health, balances, reserve floors, drip amounts and public limits.' },
          { method: 'GET', path: '/api/v1/faucet/drips', description: 'Recent drips, newest first. Query: limit (1-50), offset.' },
          { method: 'GET', path: '/api/v1/network', description: 'Calibration network health from Calix, cached ' + cfg.UPSTREAM_CACHE_SEC + 's.' },
          { method: 'GET', path: '/api/v1/sp', description: 'SP test-target status from Calix, cached ' + cfg.UPSTREAM_CACHE_SEC + 's.' },
          { method: 'GET', path: '/api/v1/openapi.json', description: 'OpenAPI 3.1 description of v1.' },
          { method: 'POST', path: '/api/v1/drip/fil', description: 'Request a tFIL drip. Captcha token or API key required.' },
          { method: 'POST', path: '/api/v1/drip/usdfc', description: 'Request a USDFC drip (0x or t410f only). Captcha token or API key required.' },
        ],
      }))

      // ─── Faucet status ───────────────────────────────────────────
      v1.get('/faucet/status', async () => {
        let state: CachedResult<DispenserState> | null = null
        let rpcError: string | null = null
        try {
          state = await dispenserCache.get()
        } catch (err) {
          rpcError = err instanceof Error ? err.message : String(err)
        }

        const assetBlock = (asset: Asset) => {
          const isFil = asset === 'fil'
          const parse = (h: string) => (isFil ? parseEther(h) : parseUnits(h, USDFC_DECIMALS))
          const fmt = (w: bigint) => (isFil ? formatEther(w) : formatUnits(w, USDFC_DECIMALS))
          const floorHuman = isFil ? cfg.MIN_RESERVE_FIL : cfg.MIN_RESERVE_USDFC
          const dripHuman = isFil ? cfg.FIL_DRIP : cfg.USDFC_DRIP
          const balance = state ? (isFil ? state.value.filBalance : state.value.usdfcBalance) : null
          const floorWei = parse(floorHuman)
          const dripWei = parse(dripHuman)
          // Same predicate as Drip.checkReserves: balance must cover reserve + one drip.
          const canDrip = balance === null ? false : balance >= floorWei + dripWei
          const block: Record<string, unknown> = {
            symbol: isFil ? 'tFIL' : 'USDFC',
            decimals: 18,
            balance: balance === null ? null : fmt(balance),
            balanceWei: balance === null ? null : balance.toString(),
            reserveFloor: floorHuman,
            reserveFloorWei: floorWei.toString(),
            dripAmount: dripHuman,
            publicDripAmount: isFil ? cfg.PUBLIC_FIL_DRIP : cfg.PUBLIC_USDFC_DRIP,
            canDrip,
          }
          if (!isFil) block.contract = cfg.USDFC_ADDRESS
          return block
        }
        const fil = assetBlock('fil')
        const usdfc = assetBlock('usdfc')
        const reasons: string[] = []
        if (!state) reasons.push('rpc_unreachable')
        if (state && !fil.canDrip) reasons.push('fil_below_reserve')
        if (state && !usdfc.canDrip) reasons.push('usdfc_below_reserve')
        const statusLight: TrafficLight = !state ? 'bad' : reasons.length ? 'watch' : 'ok'
        const s = stats.read()

        const out: Record<string, unknown> = {
          apiVersion: API_VERSION,
          ok: true,
          network: 'calibration',
          chainId: CALIBRATION_CHAIN_ID,
          healthy: statusLight === 'ok',
          state: statusLight,
          reasons,
          rpcOk: state !== null,
          dispenser: deps.dispenserAddress,
          assets: { fil, usdfc },
          limits: {
            captcha: {
              perIp: { max: cfg.MAX_DRIPS_PER_IP, windowSec: cfg.IP_RATE_LIMIT_SEC },
              perAddress: { max: cfg.MAX_DRIPS_PER_ADDRESS, windowSec: cfg.ADDRESS_RATE_LIMIT_SEC },
            },
            apiKey: {
              perKey: 'set per key by the operator',
              perAddress: { max: cfg.MAX_DRIPS_PER_ADDRESS, windowSec: cfg.ADDRESS_RATE_LIMIT_SEC },
            },
            public: {
              perIp: { max: cfg.MAX_PUBLIC_DRIPS_PER_IP, windowSec: cfg.IP_RATE_LIMIT_SEC },
              perAddress: { max: cfg.MAX_DRIPS_PER_ADDRESS, windowSec: cfg.ADDRESS_RATE_LIMIT_SEC },
            },
            requestsPerIpPerMinute: cfg.GLOBAL_RPS * 60,
            readRequestsPerIpPerMinute: limiter.max,
          },
          auth: {
            captcha: cfg.TURNSTILE_SITE_KEY ? 'turnstile' : 'disabled',
            turnstileSiteKey: cfg.TURNSTILE_SITE_KEY,
            apiKeySupported: true,
          },
          drip: {
            fil: '/api/v1/drip/fil',
            usdfc: '/api/v1/drip/usdfc',
            publicFil: '/api/public/drip/fil',
            publicUsdfc: '/api/public/drip/usdfc',
          },
          stats: {
            totalDrips: { fil: s.totalDripsFil, usdfc: s.totalDripsUsdfc },
            distributedWei: { fil: s.totalFilWei, usdfc: s.totalUsdfcWei },
            drips24h: { fil: s.filDripsToday, usdfc: s.usdfcDripsToday },
          },
        }
        if (state) Object.assign(out, freshness(state))
        else out.fetchedAt = null
        if (rpcError) out.rpcError = rpcError
        return out
      })

      // ─── Recent drips ────────────────────────────────────────────
      v1.get('/faucet/drips', async (req, reply) => {
        const q = (req.query ?? {}) as Record<string, unknown>
        const limit = parseIntParam(q.limit, 'limit', 20, 1, RECENT_DRIPS_RETENTION)
        const offset = parseIntParam(q.offset, 'offset', 0, 0, RECENT_DRIPS_RETENTION)
        if (typeof limit !== 'number') return reply.code(400).send(errorBody('bad_request', limit.error))
        if (typeof offset !== 'number') return reply.code(400).send(errorBody('bad_request', offset.error))
        const { rows, total } = stats.recentPage(limit, offset)
        const drips = rows.map((r) => {
          const amountWei = r.amountWei ?? null
          let amount: string | null = null
          if (amountWei !== null) {
            try {
              amount = r.asset === 'fil' ? formatEther(BigInt(amountWei)) : formatUnits(BigInt(amountWei), USDFC_DECIMALS)
            } catch {
              amount = null
            }
          }
          return {
            time: iso(r.unix * 1000),
            unix: r.unix,
            asset: r.asset,
            amount,
            amountWei,
            address: r.address,
            tx: r.tx,
            explorerUrl: cfg.EXPLORER_TX_URL.replace('{tx}', encodeURIComponent(r.tx)),
          }
        })
        const next = offset + drips.length
        return {
          apiVersion: API_VERSION,
          ok: true,
          network: 'calibration',
          limit,
          offset,
          total,
          nextOffset: next < total ? next : null,
          retention: RECENT_DRIPS_RETENTION,
          drips,
        }
      })

      // ─── Network health (Calix) ─────────────────────────────────
      v1.get('/network', async (_req, reply) => {
        let c
        try {
          c = await networkCache.get()
        } catch (err) {
          return upstreamFailure(reply, err, calixSource(NETWORK_ENDPOINTS))
        }
        const st = c.value.status
        const sg = c.value.signals
        const level = str(st.level)
        const forked = bool(st.forked)
        const headAge = num(st.headAgeSeconds)
        let light: TrafficLight = 'ok'
        if (level === 'watch' || level === 'upgrade') light = 'watch'
        if (headAge !== null && headAge > 300 && light === 'ok') light = 'watch'
        if (level === 'degraded' || forked === true || level === null) light = 'bad'
        const upgradeSecsLeft = num(st.upgradeSecsLeft)
        return {
          apiVersion: API_VERSION,
          ok: true,
          network: 'calibration',
          healthy: light !== 'bad',
          state: light,
          level,
          headline: str(st.headline),
          detail: str(st.detail),
          forked,
          chain: {
            epoch: num(st.epoch),
            networkVersion: num(st.networkVersion),
            headAgeSeconds: headAge,
          },
          upgrade: {
            name: str(st.upgradeName),
            epoch: num(st.upgradeEpoch),
            unix: num(st.upgradeUnix),
            secondsLeft: upgradeSecsLeft,
            activated: upgradeSecsLeft === null ? null : upgradeSecsLeft <= 0,
          },
          signals: {
            windowEpochs: num(sg.window),
            blocksPerEpoch: signal(sg.blocksPerEpoch),
            nullRoundPercent: signal(sg.nullRoundPercent),
            baseFee: signal(sg.baseFee),
            winCountAvg: signal(sg.winCountAvg),
            networkQAP: signal(sg.networkQAP),
            activeMiners: signal(sg.activeMiners),
            totalPledge: signal(sg.totalPledge),
            ipPerSector32GiB: signal(sg.ipPerSector32GiB),
          },
          source: { ...calixSource(NETWORK_ENDPOINTS), generatedAt: num(st.generatedAt) },
          ...freshness(c),
        }
      })

      // ─── SP test target (Calix) ─────────────────────────────────
      v1.get('/sp', async (_req, reply) => {
        let c
        try {
          c = await spCache.get()
        } catch (err) {
          return upstreamFailure(reply, err, calixSource([spPath]))
        }
        const miners = Array.isArray(c.value.miners) ? (c.value.miners as unknown[]).map(obj) : []
        const targets = cfg.SP_TARGETS.map((addr) => {
          const m = miners.find((x) => (str(x.address) ?? str(x.id)) === addr)
          if (!m) {
            return { address: addr, status: 'unknown', state: 'bad' as TrafficLight, healthy: false, blocksLast60: null, lastBlockEpoch: null, lastBlockAgeSec: null }
          }
          const status = (str(m.status) ?? 'unknown').toLowerCase()
          const light: TrafficLight = status === 'ok' || status === 'active' ? 'ok' : status === 'watch' ? 'watch' : 'bad'
          return {
            address: addr,
            status,
            state: light,
            healthy: light === 'ok',
            blocksLast60: num(m.blocksLast60),
            lastBlockEpoch: num(m.lastBlockEpoch),
            lastBlockAgeSec: num(m.lastBlockAgeSec),
          }
        })
        const worst: TrafficLight = targets.some((t) => t.state === 'bad')
          ? 'bad'
          : targets.some((t) => t.state === 'watch')
            ? 'watch'
            : 'ok'
        return {
          apiVersion: API_VERSION,
          ok: true,
          network: 'calibration',
          healthy: worst === 'ok',
          state: worst,
          epoch: num(c.value.epoch),
          windowEpochs: num(c.value.window),
          targets,
          source: { ...calixSource([spPath]), generatedAt: num(c.value.updatedAt) },
          ...freshness(c),
        }
      })

      // ─── OpenAPI ────────────────────────────────────────────────
      const spec = buildOpenApi(cfg)
      v1.get('/openapi.json', async () => spec)

      // ─── Drip aliases (same handler as /api/drip/*) ─────────────
      v1.post('/drip/fil', async (req, reply) => deps.handleDrip('fil', req, reply))
      v1.post('/drip/usdfc', async (req, reply) => deps.handleDrip('usdfc', req, reply))

      // Catch-all so unknown GETs under /api/v1 get the JSON envelope
      // rather than the static file server's 404.
      v1.get('/*', async (req, reply) =>
        reply.code(404).send(errorBody('not_found', 'No such endpoint: GET ' + req.url.split('?')[0])),
      )
    },
    { prefix: '/api/v1' },
  )

  function upstreamFailure(reply: FastifyReply, err: unknown, source: Record<string, unknown>) {
    const msg = err instanceof UpstreamError || err instanceof Error ? err.message : String(err)
    return reply.code(502).send(
      errorBody('upstream_unavailable', 'Calix did not answer: ' + msg, { source, retryAfterSec: 30 }),
    )
  }
}
