// SPDX-License-Identifier: MIT
//
// scripts/plumbline-cli against a real server on fake RPC + fake Calix.
// Skipped when curl or jq is missing.

import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { startFakeRpc, startFakeCalix, startFaucet, type FakeRpc, type FakeCalix, type FaucetProc } from './fakes.js'

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'plumbline-cli')
const have = (bin: string) => {
  try {
    execFileSync('sh', ['-c', 'command -v ' + bin], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const skip = !have('jq') || !have('curl') ? 'needs curl and jq' : false

describe('plumbline-cli', { skip }, () => {
  let rpc: FakeRpc
  let calix: FakeCalix
  let f: FaucetProc
  // Async on purpose: the fake RPC and Calix live in this process, so a
  // blocking spawnSync would stall them and the CLI would time out.
  const runWith = (api: string, ...args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const c = spawn(CLI, args, { env: { ...process.env, PLUMBLINE_API: api } })
      let out = ''
      let err = ''
      c.stdout.on('data', (d) => (out += d))
      c.stderr.on('data', (d) => (err += d))
      c.on('close', (code) => resolve({ code, out, err }))
    })
  const run = (...args: string[]) => runWith(f.base + '/api/v1', ...args)

  before(async () => {
    rpc = await startFakeRpc()
    calix = await startFakeCalix()
    f = await startFaucet({ RPC_URL: rpc.url, CALIX_URL: calix.url, UPSTREAM_CACHE_SEC: '1', FAUCET_STATUS_CACHE_SEC: '1' })
    await fetch(f.base + '/api/v1/drip/fil', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: '0xab00000000000000000000000000000000000001' }),
    })
  })
  after(async () => {
    await f?.stop()
    await rpc?.close()
    await calix?.close()
  })

  test('status, network, sp exit 0 when healthy', async () => {
    const s = await run('status')
    assert.equal(s.code, 0, s.err)
    assert.match(s.out, /faucet\s+ok \(healthy: true\)/)
    assert.match(s.out, /tFIL\s+balance 1000000\s+floor 20\s+drip 5/)
    const n = await run('network')
    assert.equal(n.code, 0, n.err)
    assert.match(n.out, /epoch 4209747\s+nv29/)
    const p = await run('sp')
    assert.equal(p.code, 0, p.err)
    assert.match(p.out, /t0143103\s+ok/)
  })

  test('drips lists recent drips with explorer links', async () => {
    const d = await run('drips', '--limit', '5')
    assert.equal(d.code, 0, d.err)
    assert.match(d.out, /showing 1 of 1/)
    assert.match(d.out, /fil\s+5\s+0xab0+1\s+https:\/\/calibration\.filfox\.info\/en\/message\/0x[0-9a-f]{64}/)
  })

  test('--json prints the raw v1 body', async () => {
    const j = await run('status', '--json')
    assert.equal(j.code, 0)
    assert.equal(JSON.parse(j.out).apiVersion, '1')
  })

  test('exit 2 when not healthy', async () => {
    rpc.state.balanceWei = 10n ** 18n
    calix.state.spStatus = 'bad'
    calix.state.level = 'degraded'
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal((await run('status')).code, 2)
    assert.equal((await run('sp')).code, 2)
    assert.equal((await run('network')).code, 2)
    rpc.state.balanceWei = 10n ** 24n
    calix.state.spStatus = 'ok'
    calix.state.level = 'operational'
  })

  test('exit 1 with the API error on bad input or unknown command', async () => {
    const e = await run('drips', '--limit', '500')
    assert.equal(e.code, 1)
    assert.match(e.err, /HTTP 400 bad_request/)
    assert.equal((await run('nope')).code, 1)
    const r = await runWith('http://127.0.0.1:9/api/v1', 'sp')
    assert.equal(r.code, 1)
  })
})
