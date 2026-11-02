// SPDX-License-Identifier: MIT
//
// Abuse detection for the mainnet preview.
//
// Inputs are the mainnet_events rows (one per drip request). After each
// request is recorded we compute velocity signals and compare them to
// the configured thresholds. A threshold trips when the observed value
// is MORE THAN the configured number. When MAINNET_ABUSE_AUTOBLOCK is
// on (the default) a tripped rule writes a block for its scope.
//
// Rules (anonymous captcha path only, API-key traffic is excluded from
// the IP and subnet rules because integrator CI often shares IPs):
//   ip_velocity              attempts per IP in the last hour
//   ip_address_rotation      distinct recipient addresses per IP, 24h
//   ip_captcha_failures      failed captchas per IP in the last hour
//   subnet_velocity          attempts per /24 or /48 in the last hour
//   subnet_address_rotation  distinct addresses per /24 or /48, 24h
// Address rule (all traffic):
//   address_ip_rotation      distinct verified IPs asking for one
//                            address, 24h. Only verified (captcha
//                            passed) attempts count, so a third party
//                            cannot get a victim address blocked by
//                            spamming unverified requests.

import type { AbuseThresholds } from './config.js'
import type { Block, BlockKind, MainnetLedger } from './ledger.js'

export interface AbuseContext {
  ip: string
  subnet: string
  address: string | null
  nowUnix: number
  viaApiKey: boolean
}

export interface Trip {
  rule: string
  kind: BlockKind
  value: string
  observed: number
  threshold: number
  blocked: boolean
}

/** Return the first active block that applies to this request, if any. */
export function findBlock(ledger: MainnetLedger, ctx: AbuseContext): Block | null {
  if (ctx.address) {
    const b = ledger.activeBlock('address', ctx.address, ctx.nowUnix)
    if (b) return b
  }
  if (!ctx.viaApiKey) {
    return ledger.activeBlock('ip', ctx.ip, ctx.nowUnix) ?? ledger.activeBlock('subnet', ctx.subnet, ctx.nowUnix)
  }
  return null
}

export function evaluateAbuse(ledger: MainnetLedger, t: AbuseThresholds, ctx: AbuseContext): Trip[] {
  const hourAgo = ctx.nowUnix - 3_600
  const dayAgo = ctx.nowUnix - 86_400
  const checks: Array<{ rule: string; kind: BlockKind; value: string; observed: () => number; threshold: number }> = []

  if (!ctx.viaApiKey) {
    checks.push(
      { rule: 'ip_velocity', kind: 'ip', value: ctx.ip, threshold: t.ipAttemptsPerHour,
        observed: () => ledger.countEvents({ sinceUnix: hourAgo, ip: ctx.ip }) },
      { rule: 'ip_address_rotation', kind: 'ip', value: ctx.ip, threshold: t.ipDistinctAddressesPerDay,
        observed: () => ledger.distinctAddresses({ sinceUnix: dayAgo, ip: ctx.ip }) },
      { rule: 'ip_captcha_failures', kind: 'ip', value: ctx.ip, threshold: t.ipCaptchaFailsPerHour,
        observed: () => ledger.countEvents({ sinceUnix: hourAgo, ip: ctx.ip, reason: 'captcha' }) },
      { rule: 'subnet_velocity', kind: 'subnet', value: ctx.subnet, threshold: t.subnetAttemptsPerHour,
        observed: () => ledger.countEvents({ sinceUnix: hourAgo, subnet: ctx.subnet }) },
      { rule: 'subnet_address_rotation', kind: 'subnet', value: ctx.subnet, threshold: t.subnetDistinctAddressesPerDay,
        observed: () => ledger.distinctAddresses({ sinceUnix: dayAgo, subnet: ctx.subnet }) },
    )
  }
  if (ctx.address) {
    const address = ctx.address
    checks.push({ rule: 'address_ip_rotation', kind: 'address', value: address, threshold: t.addressDistinctIpsPerDay,
      observed: () => ledger.distinctVerifiedIps(address, dayAgo) })
  }

  const trips: Trip[] = []
  for (const c of checks) {
    const observed = c.observed()
    if (observed <= c.threshold) continue
    let blocked = false
    if (t.autoBlock && !ledger.activeBlock(c.kind, c.value, ctx.nowUnix)) {
      ledger.addBlock({
        kind: c.kind,
        value: c.value,
        reason: `${c.rule}: ${observed} > ${c.threshold}`,
        createdUnix: ctx.nowUnix,
        untilUnix: ctx.nowUnix + t.blockSec,
        source: 'auto',
      })
      blocked = true
    }
    ledger.inc(`abuse_trip:${c.rule}`)
    trips.push({ rule: c.rule, kind: c.kind, value: c.value, observed, threshold: c.threshold, blocked })
  }
  return trips
}
