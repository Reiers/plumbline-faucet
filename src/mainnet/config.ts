// SPDX-License-Identifier: MIT
//
// Mainnet preview configuration.
//
// The mainnet preview is a second instance of this codebase, selected
// with NETWORK=mainnet. It has its own key, database, port, systemd
// unit and env file. Every mainnet setting uses a MAINNET_ prefix so a
// calibration .env can never be picked up by accident.
//
// All amounts are human-readable decimal strings with at most 6
// decimal places. The ledger stores micro-units (1e-6) as SQLite
// integers so cap sums are exact.

import type { Address } from 'viem'

export const MAINNET_CHAIN_ID = 314

/**
 * USDFC on Filecoin mainnet.
 * Source: FilOzone/synapse-sdk, packages/synapse-core/src/chains.ts
 * (chain id 314, contracts.usdfc.address). On-chain: symbol() = "USDFC",
 * decimals() = 18, name() = "USD for Filecoin Community".
 */
export const MAINNET_USDFC_ADDRESS: Address = '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045'
export const USDFC_DECIMALS = 18

export type MainnetAsset = 'usdfc' | 'fil'
export const ASSETS: readonly MainnetAsset[] = ['usdfc', 'fil'] as const

export interface AssetPolicy {
  /** Amount sent per successful drip, micro-units (1e-6). */
  dripMicro: bigint
  /** Max amount per recipient address per address window. */
  addressCapMicro: bigint
  /** Max amount per client IP per IP window (anonymous path only). */
  ipCapMicro: bigint
  /** Max amount per /24 (IPv4) or /48 (IPv6) per IP window (anonymous path only). */
  subnetCapMicro: bigint
  /** Global outflow cap over a rolling 24h. */
  dailyCapMicro: bigint
  /** Global outflow cap per calendar month (UTC). Hard stop. */
  monthlyCapMicro: bigint
  /** Dispenser balance that drips may never cross. */
  reserveFloorMicro: bigint
  /** Extra headroom above the floor that triggers a low-reserve warning. */
  lowReserveHeadroomMicro: bigint
}

export interface AbuseThresholds {
  /** Auto-block when a threshold trips (false = flag and log only). */
  autoBlock: boolean
  blockSec: number
  ipAttemptsPerHour: number
  ipDistinctAddressesPerDay: number
  ipCaptchaFailsPerHour: number
  subnetAttemptsPerHour: number
  subnetDistinctAddressesPerDay: number
  addressDistinctIpsPerDay: number
}

export interface MainnetConfig {
  network: 'mainnet'
  port: number
  host: string
  rpcUrl: string
  chainId: number
  usdfcAddress: Address
  /** Dispenser key. Null only in dry-run mode. */
  privateKey: `0x${string}` | null
  /** Dry run: never broadcast, simulate every send with eth_call / eth_estimateGas. */
  dryRun: boolean
  /** Watch-only dispenser address used in dry-run mode when no key is set. */
  dryRunAddress: Address | null
  dbPath: string

  /**
   * Kill switch. Defaults to ON: a fresh install refuses every drip
   * the operator has funded the float at activation and sets
   * MAINNET_KILL_SWITCH=0.
   */
  killSwitch: boolean
  /** If this file exists, drips stop immediately (no restart needed). */
  killFile: string

  /** Shown on the page, in /api/info, /api/status and in refusals. */
  statusNote: string
  /** USDFC drips need at least this much FIL (above in-flight) for gas. */
  minGasFilMicro: bigint

  addressWindowSec: number
  ipWindowSec: number
  assets: Record<MainnetAsset, AssetPolicy>

  turnstileSiteKey: string
  turnstileSecret: string
  /** Expected Turnstile action. Empty string disables the check. */
  turnstileAction: string

  /** Comma-separated proxy addresses whose X-Forwarded-For is trusted. */
  trustProxy: string
  globalRequestsPerMinute: number
  maxQueue: number
  receiptTimeoutMs: number

  abuse: AbuseThresholds

  alertWebhookUrl: string | null
  alertRepeatSec: number
  monitorIntervalSec: number
  balanceCacheSec: number
}

type Env = Record<string, string | undefined>

export class ConfigError extends Error {}

/** Parse a human decimal string into micro-units (6 dp). */
export function toMicro(value: string, name = 'amount'): bigint {
  const s = value.trim()
  const m = s.match(/^(\d+)(?:\.(\d{1,6}))?$/)
  if (!m) {
    throw new ConfigError(`${name}: "${value}" must be a non-negative decimal with at most 6 decimals`)
  }
  const whole = BigInt(m[1]!)
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'))
  return whole * 1_000_000n + frac
}

/** Micro-units back to a human decimal string (trailing zeros trimmed). */
export function fromMicro(micro: bigint): string {
  const neg = micro < 0n
  const v = neg ? -micro : micro
  const whole = v / 1_000_000n
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '')
}

/** Micro-units to 18-decimal base units (wei / attoFIL). */
export const microToWei = (micro: bigint): bigint => micro * 1_000_000_000_000n
/** 18-decimal base units to micro-units (floor). */
export const weiToMicro = (wei: bigint): bigint => wei / 1_000_000_000_000n

export const DEFAULT_STATUS_NOTE =
  'Mainnet preview: not yet activated. Docs: https://github.com/Reiers/plumbline-faucet/blob/main/docs/mainnet-preview.md'

export const DEFAULTS = {
  usdfc: { drip: '5', address: '5', ip: '10', subnet: '20', daily: '25', monthly: '100', floor: '10', headroom: '20' },
  fil: { drip: '0.05', address: '0.05', ip: '0.1', subnet: '0.2', daily: '0.25', monthly: '1', floor: '0.5', headroom: '0.2' },
} as const

export function loadMainnetConfig(env: Env = process.env): MainnetConfig {
  const str = (name: string, fallback: string): string => {
    const v = env[name]
    return v === undefined || v === '' ? fallback : v
  }
  const num = (name: string, fallback: number): number => {
    const v = env[name]
    if (v === undefined || v === '') return fallback
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative number`)
    return n
  }
  const bool = (name: string, fallback: boolean): boolean => {
    const v = env[name]
    if (v === undefined || v === '') return fallback
    return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
  }
  const micro = (name: string, fallback: string): bigint => toMicro(str(name, fallback), name)

  if (str('NETWORK', '').toLowerCase() !== 'mainnet') {
    throw new ConfigError('NETWORK=mainnet is required to start the mainnet preview')
  }

  const dryRun = bool('MAINNET_DRY_RUN', false)
  const pkRaw = env.MAINNET_FAUCET_PK ?? ''
  let privateKey: `0x${string}` | null = null
  if (pkRaw) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) {
      throw new ConfigError('MAINNET_FAUCET_PK must be a 0x-prefixed 32-byte hex key')
    }
    privateKey = pkRaw as `0x${string}`
  }
  if (!privateKey && !dryRun) {
    throw new ConfigError('MAINNET_FAUCET_PK is required unless MAINNET_DRY_RUN=1')
  }
  if (privateKey && env.FAUCET_PK && env.FAUCET_PK.toLowerCase() === privateKey.toLowerCase()) {
    throw new ConfigError('MAINNET_FAUCET_PK must not equal the calibration FAUCET_PK; use a dedicated mainnet key')
  }
  const dryRunAddressRaw = env.MAINNET_DRY_RUN_ADDRESS ?? ''
  if (dryRunAddressRaw && !/^0x[0-9a-fA-F]{40}$/.test(dryRunAddressRaw)) {
    throw new ConfigError('MAINNET_DRY_RUN_ADDRESS must be a 0x address')
  }
  if (dryRun && !privateKey && !dryRunAddressRaw) {
    throw new ConfigError('MAINNET_DRY_RUN=1 without MAINNET_FAUCET_PK needs MAINNET_DRY_RUN_ADDRESS (watch-only dispenser)')
  }

  const turnstileSiteKey = env.MAINNET_TURNSTILE_SITE_KEY ?? ''
  const turnstileSecret = env.MAINNET_TURNSTILE_SECRET ?? ''
  if (!turnstileSiteKey || !turnstileSecret) {
    // No public no-captcha path on mainnet, and no bypass flag.
    throw new ConfigError('MAINNET_TURNSTILE_SITE_KEY and MAINNET_TURNSTILE_SECRET are required on mainnet')
  }

  const asset = (prefix: 'USDFC' | 'FIL', d: (typeof DEFAULTS)['usdfc' | 'fil']): AssetPolicy => {
    const p: AssetPolicy = {
      dripMicro: micro(`MAINNET_${prefix}_DRIP`, d.drip),
      addressCapMicro: micro(`MAINNET_ADDRESS_CAP_${prefix}`, d.address),
      ipCapMicro: micro(`MAINNET_IP_CAP_${prefix}`, d.ip),
      subnetCapMicro: micro(`MAINNET_SUBNET_CAP_${prefix}`, d.subnet),
      dailyCapMicro: micro(`MAINNET_DAILY_CAP_${prefix}`, d.daily),
      monthlyCapMicro: micro(`MAINNET_MONTHLY_CAP_${prefix}`, d.monthly),
      reserveFloorMicro: micro(`MAINNET_RESERVE_FLOOR_${prefix}`, d.floor),
      lowReserveHeadroomMicro: micro(`MAINNET_LOW_RESERVE_HEADROOM_${prefix}`, d.headroom),
    }
    if (p.dripMicro <= 0n) throw new ConfigError(`MAINNET_${prefix}_DRIP must be > 0`)
    const caps: Record<string, bigint> = {
      ADDRESS_CAP: p.addressCapMicro,
      IP_CAP: p.ipCapMicro,
      SUBNET_CAP: p.subnetCapMicro,
      DAILY_CAP: p.dailyCapMicro,
      MONTHLY_CAP: p.monthlyCapMicro,
    }
    for (const [k, v] of Object.entries(caps)) {
      if (v < p.dripMicro) throw new ConfigError(`MAINNET_${k}_${prefix} must be >= MAINNET_${prefix}_DRIP`)
    }
    if (p.dailyCapMicro > p.monthlyCapMicro) {
      throw new ConfigError(`MAINNET_DAILY_CAP_${prefix} must be <= MAINNET_MONTHLY_CAP_${prefix}`)
    }
    return p
  }

  const cfg: MainnetConfig = {
    network: 'mainnet',
    port: num('MAINNET_PORT', 8006),
    host: str('MAINNET_HOST', '127.0.0.1'),
    rpcUrl: str('MAINNET_RPC_URL', 'https://api.node.glif.io/rpc/v1'),
    chainId: MAINNET_CHAIN_ID,
    usdfcAddress: str('MAINNET_USDFC_ADDRESS', MAINNET_USDFC_ADDRESS) as Address,
    privateKey,
    dryRun,
    dryRunAddress: dryRunAddressRaw ? (dryRunAddressRaw as Address) : null,
    dbPath: str('MAINNET_DB', './mainnet.sqlite'),

    killSwitch: bool('MAINNET_KILL_SWITCH', true),
    killFile: str('MAINNET_KILL_FILE', './MAINNET_KILL'),

    statusNote: str('MAINNET_STATUS_NOTE', DEFAULT_STATUS_NOTE),
    minGasFilMicro: micro('MAINNET_MIN_GAS_FIL', '0.01'),

    addressWindowSec: num('MAINNET_ADDRESS_WINDOW_SEC', 7 * 86_400),
    ipWindowSec: num('MAINNET_IP_WINDOW_SEC', 7 * 86_400),
    assets: {
      usdfc: asset('USDFC', DEFAULTS.usdfc),
      fil: asset('FIL', DEFAULTS.fil),
    },

    turnstileSiteKey,
    turnstileSecret,
    turnstileAction: env.MAINNET_TURNSTILE_ACTION ?? 'mainnet-drip',

    trustProxy: str('MAINNET_TRUST_PROXY', '127.0.0.1,::1'),
    globalRequestsPerMinute: num('MAINNET_GLOBAL_RPM', 60),
    maxQueue: num('MAINNET_MAX_QUEUE', 3),
    // Kept under the Cloudflare 100s origin timeout; slower receipts return 202.
    receiptTimeoutMs: num('MAINNET_RECEIPT_TIMEOUT_MS', 60_000),

    abuse: {
      autoBlock: bool('MAINNET_ABUSE_AUTOBLOCK', true),
      blockSec: num('MAINNET_ABUSE_BLOCK_SEC', 86_400),
      ipAttemptsPerHour: num('MAINNET_ABUSE_IP_ATTEMPTS_PER_HOUR', 20),
      ipDistinctAddressesPerDay: num('MAINNET_ABUSE_IP_DISTINCT_ADDRESSES_PER_DAY', 3),
      ipCaptchaFailsPerHour: num('MAINNET_ABUSE_IP_CAPTCHA_FAILS_PER_HOUR', 5),
      subnetAttemptsPerHour: num('MAINNET_ABUSE_SUBNET_ATTEMPTS_PER_HOUR', 60),
      subnetDistinctAddressesPerDay: num('MAINNET_ABUSE_SUBNET_DISTINCT_ADDRESSES_PER_DAY', 8),
      addressDistinctIpsPerDay: num('MAINNET_ABUSE_ADDRESS_DISTINCT_IPS_PER_DAY', 4),
    },

    alertWebhookUrl: env.MAINNET_ALERT_WEBHOOK_URL || null,
    alertRepeatSec: num('MAINNET_ALERT_REPEAT_SEC', 3_600),
    monitorIntervalSec: num('MAINNET_MONITOR_INTERVAL_SEC', 60),
    balanceCacheSec: num('MAINNET_BALANCE_CACHE_SEC', 15),
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.usdfcAddress)) throw new ConfigError('MAINNET_USDFC_ADDRESS must be a 0x address')
  if (/calibration|calibnet/i.test(cfg.rpcUrl)) throw new ConfigError('MAINNET_RPC_URL looks like a calibration endpoint')
  if (cfg.maxQueue < 1) throw new ConfigError('MAINNET_MAX_QUEUE must be >= 1')
  return cfg
}

/** Public, secret-free view of the policy (for /api/info and docs). */
export function publicPolicy(cfg: MainnetConfig) {
  const a = (p: AssetPolicy) => ({
    perDrip: fromMicro(p.dripMicro),
    perAddressCap: fromMicro(p.addressCapMicro),
    perIpCap: fromMicro(p.ipCapMicro),
    perSubnetCap: fromMicro(p.subnetCapMicro),
    dailyGlobalCap: fromMicro(p.dailyCapMicro),
    monthlyGlobalCap: fromMicro(p.monthlyCapMicro),
    reserveFloor: fromMicro(p.reserveFloorMicro),
  })
  return {
    addressWindowSec: cfg.addressWindowSec,
    ipWindowSec: cfg.ipWindowSec,
    monthlyWindow: 'calendar month, UTC',
    dailyWindow: 'rolling 24h',
    subnetPrefix: { ipv4: 24, ipv6: 48 },
    minGasFil: fromMicro(cfg.minGasFilMicro),
    usdfc: a(cfg.assets.usdfc),
    fil: a(cfg.assets.fil),
  }
}
