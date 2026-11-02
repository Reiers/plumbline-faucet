// SPDX-License-Identifier: MIT
//
// Client IP helpers for the mainnet preview: normalisation and the
// subnet bucket used for velocity limits (/24 for IPv4, /48 for IPv6).
// ASN data is not available without a GeoIP database, so the subnet is
// the coarse grouping we use instead.

import { isIP } from 'node:net'

export function normalizeIp(ip: string): string {
  const s = ip.trim().toLowerCase()
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return mapped[1]!
  return s
}

function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.split('::') as [string, string | undefined]
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail !== '' ? tail.split(':') : []
  const missing = 8 - h.length - t.length
  const mid = tail !== undefined ? Array(Math.max(0, missing)).fill('0') : []
  return [...h, ...mid, ...t].map((x) => x.padStart(4, '0'))
}

/** Subnet bucket key: "a.b.c.0/24" for IPv4, "xxxx:xxxx:xxxx::/48" for IPv6. */
export function subnetOf(ipRaw: string): string {
  const ip = normalizeIp(ipRaw)
  const v = isIP(ip)
  if (v === 4) {
    const p = ip.split('.')
    return `${p[0]}.${p[1]}.${p[2]}.0/24`
  }
  if (v === 6) {
    const parts = expandIpv6(ip)
    return `${parts.slice(0, 3).join(':')}::/48`
  }
  return `unknown:${ip}`
}
