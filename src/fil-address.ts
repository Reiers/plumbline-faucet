// SPDX-License-Identifier: MIT
//
// Filecoin address helpers. Used to detect when a recipient is a
// Filecoin-native address (t1, t3, t0) and fall back to a friendly
// error pointing the user at the lotus command to derive the
// delegated 0x equivalent. t4 (delegated EVM) addresses are converted
// inline to their underlying 0x.
//
// Future work: native t1/t3/t0 sends via the CallActor precompile
// at 0xfe00...03. Out of scope for v1 of the public faucet.

import { type Address, isAddress } from 'viem'

export type RecipientShape =
  | { kind: 'eth'; address: Address }
  | { kind: 'delegated'; address: Address; original: string } // t4/f4 → 0x
  | { kind: 'filecoin-native'; original: string; protocol: number }
  | { kind: 'invalid'; reason: string }

const NETWORK = /^[ft]/
const FIL_ADDR = /^[ft][0-4][a-zA-Z0-9]+$/

/**
 * Decode a Filecoin address string into a categorized recipient shape.
 *
 * Quick rules:
 *   t0/f0   → numeric actor ID (filecoin-native, not yet supported)
 *   t1/f1   → secp256k1 (filecoin-native, not yet supported)
 *   t2/f2   → actor (filecoin-native, not supported)
 *   t3/f3   → bls (filecoin-native, not yet supported)
 *   t4/f4   → delegated (EVM-compatible; we extract the 0x)
 *   0x...   → Ethereum-style (handled directly)
 */
export function classifyRecipient(input: string): RecipientShape {
  const s = input.trim()

  if (s.startsWith('0x')) {
    if (!isAddress(s)) return { kind: 'invalid', reason: 'malformed_eth_address' }
    return { kind: 'eth', address: s as Address }
  }

  if (NETWORK.test(s)) {
    if (!FIL_ADDR.test(s)) {
      return { kind: 'invalid', reason: 'malformed_fil_address' }
    }
    const protocol = Number(s[1])
    if (protocol === 4) {
      // f4 / t4: delegated address. Format is f4<namespace>f<base32-eth-payload+checksum>.
      // For Calibration FEVM the namespace is the EAM actor ID (10), so we
      // expect the prefix `t410f` or `f410f`. The remaining 36 base32 chars
      // (encoding 20-byte payload + 4-byte checksum) decode to the 0x
      // address embedded inside.
      const f4 = parseDelegatedF4(s)
      if (!f4) return { kind: 'invalid', reason: 'unsupported_delegated_namespace' }
      return { kind: 'delegated', address: f4, original: s }
    }
    return { kind: 'filecoin-native', original: s, protocol }
  }

  return { kind: 'invalid', reason: 'unrecognized_format' }
}

// Base32 alphabet used by Filecoin addresses (RFC 4648, lowercase, no padding).
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

function base32Decode(input: string): Uint8Array | null {
  const out: number[] = []
  let buffer = 0
  let bitsLeft = 0
  for (const ch of input.toLowerCase()) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) return null
    buffer = (buffer << 5) | idx
    bitsLeft += 5
    if (bitsLeft >= 8) {
      bitsLeft -= 8
      out.push((buffer >> bitsLeft) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

function parseDelegatedF4(s: string): Address | null {
  // Format: <network><protocol=4><namespaceVarint><sep=f><base32(payload + checksum4)>
  // Examples on Calibration: t410f<base32 of 24 bytes>
  const m = s.match(/^[ft]4([0-9]+)f([a-z2-7]+)$/i)
  if (!m) return null
  const namespace = Number(m[1])
  if (namespace !== 10) {
    // Only EAM (Ethereum Account Manager, actor id 10) is meaningful here.
    return null
  }
  const decoded = base32Decode(m[2]!)
  if (!decoded || decoded.length !== 24) return null
  const payload = decoded.slice(0, 20)
  const hex = '0x' + Array.from(payload, (b) => b.toString(16).padStart(2, '0')).join('')
  return hex as Address
}
