// SPDX-License-Identifier: MIT
//
// Unspendable recipients (zero address and friends) must be refused with
// 400 unspendable_address on every drip path, before captcha, rate
// limits or any transaction. Two public drips went to the zero address
// in October 2026; these tests pin the fix.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRecipient, unspendableReason } from '../src/fil-address.js'
import { startFakeRpc, startFaucet, type FakeRpc, type FaucetProc } from './fakes.js'

type J = Record<string, any>

const ZERO = '0x0000000000000000000000000000000000000000'
// t410f form of the zero address (payload is 20 zero bytes; the parser
// does not verify the checksum, so 4 zero checksum bytes are used here).
const ZERO_T410F = 't410f' + 'a'.repeat(39)

const REFUSED: Array<[string, string]> = [
  [ZERO, 'zero_address'],
  ['0x0000000000000000000000000000000000000000'.toUpperCase().replace('0X', '0x'), 'zero_address'],
  [ZERO_T410F, 'zero_address'],
  ['f410f' + 'a'.repeat(39), 'zero_address'],
  ['0x0000000000000000000000000000000000000001', 'evm_precompile'],
  ['0x00000000000000000000000000000000000000ff', 'evm_precompile'],
  ['0xfe00000000000000000000000000000000000003', 'fevm_precompile'],
  ['0xFE00000000000000000000000000000000000001', 'fevm_precompile'],
  ['0xff00000000000000000000000000000000000064', 'masked_id_address'],
  ['0xff0000000000000000000000000000000002f05f', 'masked_id_address'],
  ['0x000000000000000000000000000000000000dEaD', 'burn_address'],
  ['t00', 'builtin_actor'],
  ['f00', 'builtin_actor'],
  ['t099', 'builtin_actor'],
  ['f010', 'builtin_actor'],
]

const ALLOWED = [
  '0x1aB747560deFa40D27627AA507c6bd3680c28c6B',
  '0x0000000000000000000000000000000000000100',
  '0xfe00000000000000000000000000000000000100'.replace('0xfe00', '0xfe01'),
  't0100',
  't0143103',
  'f01000',
  't1abjxfbp274xpdqcpuaykwkfb43omjotacm2p3za',
]

test('unspendableReason classifies the refused forms', () => {
  for (const [a, why] of REFUSED) {
    const r = classifyRecipient(a)
    assert.notEqual(r.kind, 'invalid', a + ' should parse')
    assert.equal(unspendableReason(r), why, a)
  }
})

test('unspendableReason lets ordinary recipients through', () => {
  for (const a of ALLOWED) {
    const r = classifyRecipient(a)
    assert.notEqual(r.kind, 'invalid', a + ' should parse')
    assert.equal(unspendableReason(r), null, a)
  }
})

async function post(base: string, p: string, json: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(json),
  })
  return { status: r.status, body: (await r.json()) as J }
}
const ip = (n: number) => ({ 'x-forwarded-for': '198.51.100.' + n })

const POST_PATHS = [
  '/api/drip/fil',
  '/api/drip/usdfc',
  '/api/v1/drip/fil',
  '/api/v1/drip/usdfc',
  '/api/public/drip/fil',
  '/api/public/drip/usdfc',
]

describe('unspendable recipients on every drip path', () => {
  let rpc: FakeRpc
  let f: FaucetProc
  const sends = () => rpc.state.calls['eth_sendRawTransaction'] ?? 0

  before(async () => {
    rpc = await startFakeRpc()
    // Captcha ON: proves the check runs before Turnstile.
    f = await startFaucet({
      RPC_URL: rpc.url,
      CALIX_URL: 'http://127.0.0.1:9',
      TURNSTILE_SECRET: 'test-secret',
      TURNSTILE_SITE_KEY: 'test-site-key',
    })
  })
  after(async () => {
    await f?.stop()
    await rpc?.close()
  })

  test('POST drip paths answer 400 unspendable_address and send nothing', async () => {
    const start = sends()
    let n = 0
    for (const p of POST_PATHS) {
      for (const [a, why] of REFUSED) {
        // native t0 forms are refused for usdfc already as unsupported; skip
        if (p.endsWith('usdfc') && /^[ft]0/.test(a)) continue
        const r = await post(f.base, p, { address: a }, ip(1))
        assert.equal(r.status, 400, p + ' ' + a + ' ' + JSON.stringify(r.body))
        assert.equal(r.body.ok, false)
        assert.equal(r.body.error, 'unspendable_address', p + ' ' + a)
        assert.equal(r.body.reason, why, p + ' ' + a)
        assert.equal(typeof r.body.message, 'string')
        if (p.startsWith('/api/v1/')) assert.equal(r.body.apiVersion, '1')
        n++
      }
    }
    assert.ok(n > 60)
    assert.equal(sends(), start, 'no transaction may be sent')
  })

  test('unspendable check runs before API-key auth too', async () => {
    const r = await post(f.base, '/api/v1/drip/fil', { address: ZERO }, { ...ip(2), 'x-api-key': 'pk_not_a_real_key' })
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'unspendable_address')
  })

  test('claim_token_all answers 400 with unspendable_address on both elements', async () => {
    const start = sends()
    for (const a of [ZERO, ZERO_T410F, '0xfe00000000000000000000000000000000000003', 't00']) {
      const r = await fetch(f.base + '/api/claim_token_all?address=' + encodeURIComponent(a), { headers: ip(3) })
      const body = (await r.json()) as J[]
      assert.equal(r.status, 400, a)
      assert.equal(body.length, 2)
      for (const el of body) {
        assert.equal(el.tx_hash, undefined)
        assert.equal(el.error.code, 'unspendable_address', a)
        assert.match(el.error.message, /^unspendable_address: /)
      }
    }
    assert.equal(sends(), start)
  })

  test('refused requests do not burn drip quotas', async () => {
    // ip(1) and ip(3) were refused many times above. The public path
    // allows one drip per IP per window; it must still be available.
    const good = '0xab00000000000000000000000000000000000001'
    const r = await post(f.base, '/api/public/drip/fil', { address: good }, ip(1))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
    const c = await fetch(f.base + '/api/claim_token_all?address=0xab00000000000000000000000000000000000002', { headers: ip(3) })
    const body = (await c.json()) as J[]
    assert.equal(c.status, 200)
    assert.ok(body.every((el) => typeof el.tx_hash === 'string'), JSON.stringify(body))
  })

  test('ordinary address on the captcha path still needs a token', async () => {
    const r = await post(f.base, '/api/v1/drip/fil', { address: '0xab00000000000000000000000000000000000003' }, ip(4))
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'captcha')
  })
})
