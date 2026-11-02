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

// ─── Unspendable recipients ─────────────────────────────────────────
//
// Addresses that parse fine but where nobody can ever spend the funds.
// Drips to them are pure loss, so every drip path refuses them with
// 400 unspendable_address before captcha, rate limits or any RPC call.
//
//   zero_address         0x0000000000000000000000000000000000000000,
//                        also as t410f/f410f (delegated form of the same bytes)
//   evm_precompile       0x00..0001 to 0x00..00ff (Ethereum precompile range)
//   fevm_precompile      0xfe00000000000000000000000000000000000000..ff
//                        (Filecoin precompiles, incl. CallActor at ..03)
//   masked_id_address    0xff0000000000000000000000 + 8-byte actor id
//                        (FEVM masked ID addresses; the drip would bypass
//                        the address-shape checks below)
//   builtin_actor        t0/f0 ids below 100: system, init, reward, cron,
//                        power, market, verifreg, datacap, EAM, burnt funds
//   burn_address         0x000000000000000000000000000000000000dEaD

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead'
const MIN_USER_ACTOR_ID = 100n

export type UnspendableReason =
  | 'zero_address'
  | 'evm_precompile'
  | 'fevm_precompile'
  | 'masked_id_address'
  | 'builtin_actor'
  | 'burn_address'

export function unspendableReason(r: RecipientShape): UnspendableReason | null {
  if (r.kind === 'eth' || r.kind === 'delegated') {
    const a = r.address.toLowerCase()
    if (a === ZERO_ADDRESS) return 'zero_address'
    if (a === DEAD_ADDRESS) return 'burn_address'
    if (a.startsWith('0x' + '00'.repeat(19))) return 'evm_precompile'
    if (a.startsWith('0xfe' + '00'.repeat(18))) return 'fevm_precompile'
    if (a.startsWith('0xff' + '00'.repeat(11))) return 'masked_id_address'
    return null
  }
  if (r.kind === 'filecoin' && r.protocol === 0) {
    const id = BigInt(r.original.slice(2))
    if (id < MIN_USER_ACTOR_ID) return 'builtin_actor'
  }
  return null
}

export const UNSPENDABLE_MESSAGE: Record<UnspendableReason, string> = {
  zero_address: 'The zero address cannot spend funds. Send your own wallet address.',
  evm_precompile: 'This is an Ethereum precompile address. Funds sent there are lost.',
  fevm_precompile: 'This is a Filecoin precompile address. Funds sent there are lost.',
  masked_id_address: 'Masked ID addresses (0xff00...) are not accepted. Use the 0x or t410f address of your wallet.',
  builtin_actor: 'This is a built-in system actor (ID below 100). Funds sent there are lost.',
  burn_address: 'This is a well-known burn address. Funds sent there are lost.',
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
