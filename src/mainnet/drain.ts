// SPDX-License-Identifier: MIT
//
// Withdraw all or part of the mainnet float to a withdrawal address
// (also used to move it on key rotation
// or shutdown). Simulates by default; pass --execute to broadcast.
//
//   pnpm mainnet:drain --to 0xWithdrawal                     # plan + simulate, everything
//   pnpm mainnet:drain --to 0xWithdrawal --execute           # send USDFC, then FIL
//   pnpm mainnet:drain --to 0xWithdrawal --usdfc 50 --fil 0  # partial withdrawal
//
// Turn the kill switch on first so no drip races the drain. FIL keeps
// --keep-fil (default 0.01) behind to pay gas for the USDFC transfer
// and the FIL transfer itself.

import 'dotenv/config'
import { formatEther, type Address } from 'viem'
import { loadMainnetConfig, toMicro, microToWei } from './config.js'
import { MainnetDispenser } from './dispenser.js'

async function main() {
  const args = process.argv.slice(2)
  const get = (k: string) => {
    const i = args.indexOf('--' + k)
    return i >= 0 ? args[i + 1] : undefined
  }
  const to = get('to')
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('--to 0x... is required')
  const execute = args.includes('--execute')
  const keepFil = microToWei(toMicro(get('keep-fil') ?? '0.01', 'keep-fil'))

  const cfg = loadMainnetConfig(process.env)
  const d = new MainnetDispenser(cfg)
  if ((await d.chainId()) !== 314) throw new Error('RPC is not Filecoin mainnet')
  const b = await d.balances()
  const maxFil = b.fil > keepFil ? b.fil - keepFil : 0n
  const want = (k: string, max: bigint): bigint => {
    const v = get(k)
    if (v === undefined) return max
    const wei = microToWei(toMicro(v, k))
    if (wei > max) throw new Error(`--${k} ${v} is more than is available (${formatEther(max)})`)
    return wei
  }
  const usdfcOut = want('usdfc', b.usdfc)
  const filOut = want('fil', maxFil)
  console.log(JSON.stringify({ dispenser: d.address, to, usdfc: formatEther(b.usdfc), fil: formatEther(b.fil), usdfcToSend: formatEther(usdfcOut), filToSend: formatEther(filOut), execute }, null, 2))

  if (usdfcOut > 0n) {
    const sim = await d.simulate('usdfc', to as Address, usdfcOut)
    console.log('usdfc transfer simulates ok, gas', sim.gas.toString())
  }
  if (filOut > 0n) {
    const sim = await d.simulate('fil', to as Address, filOut)
    console.log('fil transfer simulates ok, gas', sim.gas.toString())
  }
  if (!execute) {
    console.log('dry run only. Re-run with --execute to broadcast.')
    return
  }
  if (cfg.dryRun) throw new Error('MAINNET_DRY_RUN=1: refusing to execute a drain')
  if (usdfcOut > 0n) {
    const r = await d.broadcast('usdfc', to as Address, usdfcOut)
    console.log('usdfc tx', r.txHash, await d.waitForReceipt(r.txHash!, 300_000))
  }
  if (filOut > 0n) {
    const r = await d.broadcast('fil', to as Address, filOut)
    console.log('fil tx', r.txHash, await d.waitForReceipt(r.txHash!, 300_000))
  }
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
