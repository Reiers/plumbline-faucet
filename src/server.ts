// SPDX-License-Identifier: MIT
//
// calibration-faucet HTTP server.
//
// Routes:
//   GET  /                  static landing page (serves public/index.html)
//   GET  /healthz           liveness probe
//   GET  /api/info          public faucet metadata
//   GET  /api/stats         lifetime + 24h aggregate counters
//   GET  /api/recent        last N drips (address + tx hashes only)
//   POST /api/drip          { address, turnstileToken } → drip + record
//
// Bot protection: Cloudflare Turnstile on /api/drip when configured.
// Rate limiting: per-IP and per-address (24h default), plus a global
// per-IP burst at the Fastify layer.

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimitPlugin from '@fastify/rate-limit'
import staticPlugin from '@fastify/static'
import { z } from 'zod'
import { isAddress, type Address, parseEther, parseUnits } from 'viem'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.js'
import { RateLimitStore } from './rate-limit-store.js'
import { StatsStore } from './stats-store.js'
import { Drip } from './drip.js'
import { verifyTurnstile } from './turnstile.js'

const USDFC_DECIMALS = 18

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  const cfg = loadConfig()
  const store = new RateLimitStore(cfg.RATE_LIMIT_DB)
  const stats = new StatsStore(store.db)
  const drip = new Drip(cfg)

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: cfg.TRUSTED_PROXY,
  })

  await app.register(cors, { origin: true })
  await app.register(rateLimitPlugin, {
    max: cfg.GLOBAL_RPS * 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })

  await app.register(staticPlugin, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  })

  // ─── Health ─────────────────────────────────────────────────────
  app.get('/healthz', async () => {
    const state = await drip.state()
    return {
      ok: true,
      dispenser: state.address,
      fil: state.filBalance.toString(),
      usdfc: state.usdfcBalance.toString(),
    }
  })

  // ─── Info (rendered by the UI) ──────────────────────────────────
  app.get('/api/info', async () => {
    const state = await drip.state()
    return {
      brand: cfg.BRAND_NAME,
      brandUrl: cfg.BRAND_URL,
      filDrip: cfg.FIL_DRIP,
      usdfcDrip: cfg.USDFC_DRIP,
      ipRateLimitSec: cfg.IP_RATE_LIMIT_SEC,
      addressRateLimitSec: cfg.ADDRESS_RATE_LIMIT_SEC,
      turnstileSiteKey: cfg.TURNSTILE_SITE_KEY,
      usdfcAddress: cfg.USDFC_ADDRESS,
      rpcUrl: cfg.RPC_URL,
      dispenser: state.address,
      // Live balances exposed for the UI's status panel
      filBalanceWei: state.filBalance.toString(),
      usdfcBalanceWei: state.usdfcBalance.toString(),
      minReserveFil: cfg.MIN_RESERVE_FIL,
      minReserveUsdfc: cfg.MIN_RESERVE_USDFC,
    }
  })

  // ─── Stats ──────────────────────────────────────────────────────
  app.get('/api/stats', async () => stats.read())

  app.get('/api/recent', async (req) => {
    const limit = Math.min(50, Math.max(1, Number((req.query as { limit?: string }).limit ?? 10)))
    return { drips: stats.recent(limit) }
  })

  // ─── POST /api/drip ─────────────────────────────────────────────
  const dripBody = z.object({
    address: z.string().refine((s) => isAddress(s), { message: 'invalid_address' }),
    turnstileToken: z.string().optional(),
  })

  app.post('/api/drip', async (req, reply) => {
    const ip = req.ip
    const parsed = dripBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'bad_request' })
    }
    const recipient = parsed.data.address as Address

    const tsResult = await verifyTurnstile(cfg, parsed.data.turnstileToken ?? '', ip)
    if (!tsResult.ok) {
      return reply
        .code(400)
        .send({ ok: false, error: 'captcha', reason: tsResult.reason })
    }

    const now = Math.floor(Date.now() / 1000)
    const lastIp = store.lastDripForIp(ip)
    if (lastIp && now - lastIp < cfg.IP_RATE_LIMIT_SEC) {
      return reply.code(429).send({
        ok: false,
        error: 'ip_rate_limited',
        retryAfterSec: cfg.IP_RATE_LIMIT_SEC - (now - lastIp),
      })
    }
    const lastAddr = store.lastDripForAddress(recipient)
    if (lastAddr && now - lastAddr < cfg.ADDRESS_RATE_LIMIT_SEC) {
      return reply.code(429).send({
        ok: false,
        error: 'address_rate_limited',
        retryAfterSec: cfg.ADDRESS_RATE_LIMIT_SEC - (now - lastAddr),
      })
    }

    const reserveProblem = await drip.checkReserves()
    if (reserveProblem) {
      app.log.warn({ reserveProblem }, 'faucet dry')
      return reply
        .code(503)
        .send({ ok: false, error: 'faucet_dry', reason: reserveProblem })
    }

    try {
      const result = await drip.drip(recipient)
      store.recordDrip(ip, recipient, now)
      stats.recordDrip(
        now,
        recipient,
        result.filTxHash,
        result.usdfcTxHash,
        parseEther(cfg.FIL_DRIP),
        parseUnits(cfg.USDFC_DRIP, USDFC_DECIMALS),
      )
      app.log.info(
        {
          recipient,
          ip,
          filTxHash: result.filTxHash,
          usdfcTxHash: result.usdfcTxHash,
        },
        'drip ok',
      )
      return { ok: true, ...result }
    } catch (err) {
      app.log.error({ err, recipient, ip }, 'drip failed')
      return reply
        .code(500)
        .send({ ok: false, error: 'drip_failed', reason: String(err) })
    }
  })

  if (!cfg.TURNSTILE_SECRET) {
    app.log.warn(
      'TURNSTILE_SECRET not set — captcha is disabled. Do NOT use this in production.',
    )
  }
  app.log.info(
    { dispenser: drip.dispenserAddress, filDrip: cfg.FIL_DRIP, usdfcDrip: cfg.USDFC_DRIP },
    'faucet starting',
  )

  await app.listen({ host: cfg.HOST, port: cfg.PORT })
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
