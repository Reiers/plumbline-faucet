// SPDX-License-Identifier: MIT
//
// Test fakes: a minimal Ethereum JSON-RPC server (enough for viem to read
// balances and "send" transactions), a fake Calix API, and a helper that
// spawns the real faucet entry point (src/server.ts) against them.
// Nothing here touches a real chain or spends funds.

import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { generatePrivateKey } from 'viem/accounts'

export interface Fake {
  url: string
  close: () => Promise<void>
}

const listen = (srv: http.Server): Promise<string> =>
  new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as net.AddressInfo
      resolve('http://127.0.0.1:' + a.port)
    })
  })

const closer = (srv: http.Server) => () =>
  new Promise<void>((resolve) => {
    srv.closeAllConnections?.()
    srv.close(() => resolve())
  })

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })

const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16)
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')

// ─── Fake EVM JSON-RPC ──────────────────────────────────────────────

export interface FakeRpc extends Fake {
  state: { down: boolean; balanceWei: bigint; calls: Record<string, number> }
}

export async function startFakeRpc(): Promise<FakeRpc> {
  const state = { down: false, balanceWei: 10n ** 24n, calls: {} as Record<string, number> }
  let nonce = 0
  const block = () => ({
    number: '0x10',
    hash: '0x' + '11'.repeat(32),
    parentHash: '0x' + '22'.repeat(32),
    timestamp: hex(Math.floor(Date.now() / 1000)),
    baseFeePerGas: '0x64',
    gasLimit: '0x2faf080',
    gasUsed: '0x0',
    miner: '0x' + '00'.repeat(20),
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    logsBloom: '0x' + '00'.repeat(256),
    nonce: '0x0000000000000000',
    receiptsRoot: '0x' + '33'.repeat(32),
    sha3Uncles: '0x' + '44'.repeat(32),
    size: '0x100',
    stateRoot: '0x' + '55'.repeat(32),
    transactionsRoot: '0x' + '66'.repeat(32),
    mixHash: '0x' + '00'.repeat(32),
    transactions: [],
    uncles: [],
  })
  const handle = (m: { id: unknown; method: string; params?: unknown[] }) => {
    state.calls[m.method] = (state.calls[m.method] ?? 0) + 1
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result })
    switch (m.method) {
      case 'eth_chainId':
        return ok(hex(314159))
      case 'net_version':
        return ok('314159')
      case 'eth_getBalance':
        return ok(hex(state.balanceWei))
      case 'eth_call':
        return ok(word(state.balanceWei))
      case 'eth_getTransactionCount':
        return ok(hex(nonce))
      case 'eth_estimateGas':
        return ok('0x186a0')
      case 'eth_maxPriorityFeePerGas':
        return ok('0x1')
      case 'eth_gasPrice':
        return ok('0x64')
      case 'eth_feeHistory':
        return ok({ oldestBlock: '0x10', baseFeePerGas: ['0x64', '0x64'], gasUsedRatio: [0.5], reward: [['0x1']] })
      case 'eth_getBlockByNumber':
        return ok(block())
      case 'eth_blockNumber':
        return ok('0x10')
      case 'eth_sendRawTransaction':
        nonce += 1
        return ok('0x' + randomBytes(32).toString('hex'))
      case 'eth_getTransactionReceipt': {
        const h = (m.params?.[0] as string) ?? '0x'
        return ok({
          transactionHash: h,
          transactionIndex: '0x0',
          blockHash: '0x' + '11'.repeat(32),
          blockNumber: '0x10',
          from: '0x' + '00'.repeat(20),
          to: '0x' + '00'.repeat(20),
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x64',
          contractAddress: null,
          logs: [],
          logsBloom: '0x' + '00'.repeat(256),
          status: '0x1',
          type: '0x2',
        })
      }
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } }
    }
  }
  const srv = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    if (state.down) {
      res.writeHead(503).end('down')
      return
    }
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      res.writeHead(400).end()
      return
    }
    const out = Array.isArray(msg) ? msg.map(handle) : handle(msg as never)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
  })
  return { url: await listen(srv), close: closer(srv), state }
}

// ─── Fake Calix ─────────────────────────────────────────────────────

export interface FakeCalix extends Fake {
  state: { down: boolean; hits: Record<string, number>; spStatus: string; level: string }
}

export async function startFakeCalix(): Promise<FakeCalix> {
  const state = { down: false, hits: {} as Record<string, number>, spStatus: 'ok', level: 'operational' }
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    state.hits[u.pathname] = (state.hits[u.pathname] ?? 0) + 1
    if (state.down) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('down')
      return
    }
    const now = Math.floor(Date.now() / 1000)
    let body: unknown
    if (u.pathname === '/api/v1/status') {
      body = {
        level: state.level, headline: 'All systems operational', detail: 'Calibration nv29 producing blocks normally',
        epoch: 4209747, height: 4209747, networkVersion: 29, headAgeSeconds: 26, upgradeName: 'Solstice',
        upgradeEpoch: 4109133, upgradeUnix: 1790600370, upgradeSecsLeft: -3018446, upgradeEpochsLeft: -100614,
        forked: false, generatedAt: now,
      }
    } else if (u.pathname === '/api/v1/signals') {
      body = {
        generatedAt: now, epoch: 4209747, window: 60,
        blocksPerEpoch: { value: 3.01, unit: 'blocks', status: 'ok' },
        nullRoundPercent: { value: 0, unit: '%', status: 'ok' },
        baseFee: { value: 101.08, unit: 'atto', status: 'ok' },
        winCountAvg: { value: 5.78, unit: 'wins', status: 'ok' },
        networkQAP: { value: 1065.75, unit: 'TiB', status: 'ok' },
        activeMiners: { value: 8, unit: 'miners', status: 'watch' },
        totalPledge: { value: 3725498.8, unit: 'FIL', status: 'ok' },
        ipPerSector32GiB: { value: 38.58, unit: 'FIL/32GiB', status: 'ok' },
        series: { baseFeeNFil: [100, 113] },
      }
    } else if (u.pathname === '/api/v1/miners/status') {
      const addrs = (u.searchParams.get('addrs') ?? '').split(',')
      body = {
        epoch: 4209747, window: 60, updatedAt: now,
        miners: addrs.map((a) => ({ address: a, blocksLast60: 54, lastBlockAgeSec: 26, lastBlockEpoch: 4209747, status: state.spStatus })),
      }
    } else {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  return { url: await listen(srv), close: closer(srv), state }
}

// ─── Faucet process ─────────────────────────────────────────────────

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

export interface FaucetProc {
  base: string
  proc: ChildProcess
  dbPath: string
  logs: () => string
  stop: () => Promise<void>
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

export async function startFaucet(env: Record<string, string>): Promise<FaucetProc> {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbline-faucet-test-'))
  const dbPath = path.join(dir, 'rate-limits.sqlite')
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LOG_LEVEL: 'warn',
    FAUCET_PK: generatePrivateKey(), // throwaway key, never funded
    PORT: String(port),
    HOST: '127.0.0.1',
    RATE_LIMIT_DB: dbPath,
    TRUSTED_PROXY: 'true',
    ...env,
  }
  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx')
  const proc = spawn(tsx, ['src/server.ts'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  proc.stdout?.on('data', (c) => (out += c))
  proc.stderr?.on('data', (c) => (out += c))
  const base = 'http://127.0.0.1:' + port
  const deadline = Date.now() + 20_000
  for (;;) {
    if (proc.exitCode !== null) throw new Error('faucet exited early:\n' + out)
    try {
      const r = await fetch(base + '/api/v1/openapi.json')
      if (r.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL')
      throw new Error('faucet did not start:\n' + out)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return {
    base,
    proc,
    dbPath,
    logs: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve()
        proc.once('exit', () => {
          fs.rmSync(dir, { recursive: true, force: true })
          resolve()
        })
        proc.kill('SIGTERM')
      }),
  }
}
