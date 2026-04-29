// SPDX-License-Identifier: MIT
//
// Filecoin address helpers.
//
// classifyRecipient() returns a shape that the drip handler routes on:
//   eth         → 0x...    (handled by viem.sendTransaction directly)
//   delegated   → t410f... (extract embedded 0x, then handle as eth)
//   filecoin    → t1/t3/t0 (handled by the FEVM CallActor precompile)
//   invalid     → malformed input
//
// For the filecoin protocol-byte encoding, the layout is:
//   protocol = 0  (id): leb128(actor_id)
//   protocol = 1  (secp256k1): 20 bytes  (Blake2b-160 of pubkey)
//   protocol = 3  (bls):       48 bytes  (BLS pubkey)
// Final raw bytes for the precompile = [protocol_byte, ...payload].

import { type Address, isAddress } from 'viem'

export type RecipientShape =
  | { kind: 'eth'; address: Address }
  | { kind: 'delegated'; address: Address; original: string } // t4/f4 → 0x
  | { kind: 'filecoin'; protocol: 0 | 1 | 2 | 3; bytes: Uint8Array; original: string }
  | { kind: 'invalid'; reason: string }

const FIL_ADDR = /^[ft][0-4][a-zA-Z0-9]+$/

export function classifyRecipient(input: string): RecipientShape {
  const s = input.trim()

  if (s.startsWith('0x')) {
    if (!isAddress(s)) return { kind: 'invalid', reason: 'malformed_eth_address' }
    return { kind: 'eth', address: s as Address }
  }

  if (!FIL_ADDR.test(s)) {
    return { kind: 'invalid', reason: 'unrecognized_format' }
  }
  const protocol = Number(s[1])

  if (protocol === 0) {
    // t0123 — actor ID encoded as decimal in the string form.
    const idStr = s.slice(2)
    if (!/^\d+$/.test(idStr)) return { kind: 'invalid', reason: 'malformed_t0' }
    const id = BigInt(idStr)
    return { kind: 'filecoin', protocol: 0, bytes: encodeT0(id), original: s }
  }
  if (protocol === 4) {
    const f4 = parseDelegatedF4(s)
    if (!f4) return { kind: 'invalid', reason: 'unsupported_delegated_namespace' }
    return { kind: 'delegated', address: f4, original: s }
  }
  if (protocol === 1 || protocol === 2 || protocol === 3) {
    const decoded = base32Decode(s.slice(2))
    if (!decoded) return { kind: 'invalid', reason: 'malformed_base32' }
    // payload + 4-byte checksum. Protocol 1 (secp256k1) and protocol 2
    // (actor) both have 20-byte payloads (Blake2b-160 hashes); protocol
    // 3 (BLS) has a 48-byte payload (the BLS pubkey).
    const expectedLen = protocol === 3 ? 52 : 24
    if (decoded.length !== expectedLen) {
      return { kind: 'invalid', reason: `unexpected_length_${decoded.length}` }
    }
    const payload = decoded.slice(0, decoded.length - 4)
    const out = new Uint8Array(payload.length + 1)
    out[0] = protocol
    out.set(payload, 1)
    return { kind: 'filecoin', protocol, bytes: out, original: s }
  }

  return { kind: 'invalid', reason: 'unsupported_protocol' }
}

function encodeT0(id: bigint): Uint8Array {
  // [0x00, ...leb128(id)]
  const out: number[] = [0x00]
  let n = id
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n))
    n >>= 7n
  }
  out.push(Number(n))
  return Uint8Array.from(out)
}

// Base32 alphabet used by Filecoin (RFC 4648, lowercase, no padding).
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32Decode(input: string): Uint8Array | null {
  const out: number[] = []
  let buffer = 0
  let bitsLeft = 0
  for (const ch of input.toLowerCase()) {
    const idx = B32.indexOf(ch)
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
  const m = s.match(/^[ft]4([0-9]+)f([a-z2-7]+)$/i)
  if (!m) return null
  const namespace = Number(m[1])
  if (namespace !== 10) return null
  const decoded = base32Decode(m[2]!)
  if (!decoded || decoded.length !== 24) return null
  const payload = decoded.slice(0, 20)
  return ('0x' + Array.from(payload, (b) => b.toString(16).padStart(2, '0')).join('')) as Address
}
