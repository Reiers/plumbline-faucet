// SPDX-License-Identifier: MIT
//
// Faucet configuration. Every setting is overridable via environment
// variable so deployments can dial drip amounts and rate limits without
// a redeploy. Defaults are tuned for a public Calibration faucet that
// has to defend itself against bots.

import 'dotenv/config'
import type { Address } from 'viem'

export interface FaucetConfig {
  // ─── Network / dispenser ─────────────────────────────────────────
  PORT: number
  HOST: string
  RPC_URL: string
  USDFC_ADDRESS: Address
  FAUCET_PK: `0x${string}`

  // ─── Drip amounts ────────────────────────────────────────────────
  FIL_DRIP: string   // human-readable, e.g. "5"
  USDFC_DRIP: string // human-readable, e.g. "100"

  // ─── Rate limits ─────────────────────────────────────────────────
  IP_RATE_LIMIT_SEC: number
  ADDRESS_RATE_LIMIT_SEC: number
  /** Max drips per IP per asset within IP_RATE_LIMIT_SEC. */
  MAX_DRIPS_PER_IP: number
  /** Max drips per address per asset within ADDRESS_RATE_LIMIT_SEC. */
  MAX_DRIPS_PER_ADDRESS: number
  GLOBAL_RPS: number

  // ─── Bot protection ──────────────────────────────────────────────
  TURNSTILE_SITE_KEY: string | null
  TURNSTILE_SECRET: string | null

  // ─── Operational ─────────────────────────────────────────────────
  RATE_LIMIT_DB: string
  MIN_RESERVE_FIL: string   // refuse drips when balance falls below
  MIN_RESERVE_USDFC: string
  TRUSTED_PROXY: boolean    // honor X-Forwarded-For when true

  // ─── Branding (rendered in the UI) ───────────────────────────────
  BRAND_NAME: string
  BRAND_URL: string
}

const required = (name: string): string => {
  const v = process.env[name]
  if (!v) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

const opt = (name: string, fallback: string): string =>
  process.env[name] ?? fallback

const optNum = (name: string, fallback: number): number =>
  process.env[name] ? Number(process.env[name]) : fallback

const optBool = (name: string, fallback: boolean): boolean => {
  const v = process.env[name]
  if (v === undefined) return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

export function loadConfig(): FaucetConfig {
  return {
    PORT: optNum('PORT', 8003),
    HOST: opt('HOST', '0.0.0.0'),
    RPC_URL: opt('RPC_URL', 'https://api.calibration.node.glif.io/rpc/v1'),
    USDFC_ADDRESS: opt(
      'USDFC_ADDRESS',
      '0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0',
    ) as Address,
    FAUCET_PK: required('FAUCET_PK') as `0x${string}`,

    FIL_DRIP: opt('FIL_DRIP', '5'),
    USDFC_DRIP: opt('USDFC_DRIP', '100'),

    IP_RATE_LIMIT_SEC: optNum('IP_RATE_LIMIT_SEC', 86_400),       // 24h
    ADDRESS_RATE_LIMIT_SEC: optNum('ADDRESS_RATE_LIMIT_SEC', 86_400),
    MAX_DRIPS_PER_IP:      optNum('MAX_DRIPS_PER_IP',      2),
    MAX_DRIPS_PER_ADDRESS: optNum('MAX_DRIPS_PER_ADDRESS', 2),
    GLOBAL_RPS: optNum('GLOBAL_RPS', 5),

    TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY ?? null,
    TURNSTILE_SECRET: process.env.TURNSTILE_SECRET ?? null,

    RATE_LIMIT_DB: opt('RATE_LIMIT_DB', './rate-limits.sqlite'),
    MIN_RESERVE_FIL: opt('MIN_RESERVE_FIL', '20'),
    MIN_RESERVE_USDFC: opt('MIN_RESERVE_USDFC', '500'),
    TRUSTED_PROXY: optBool('TRUSTED_PROXY', true),

    BRAND_NAME: opt('BRAND_NAME', 'Calibration Faucet'),
    BRAND_URL: opt('BRAND_URL', ''),
  }
}
