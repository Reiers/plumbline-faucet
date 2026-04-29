// SPDX-License-Identifier: MIT
//
// Drip executor: sends tFIL or USDFC from the dispenser to a recipient.
//
// tFIL routing depends on the recipient form:
//   - 0x or t410f (extracted to 0x) → standard EVM sendTransaction
//   - t1/t3/t0 (Filecoin native)    → CallActor precompile at
//                                       0xfe00000000000000000000000000000000000003
//                                     with method=0 (Send), value=amount,
//                                     and target address bytes encoded into
//                                     the precompile's standard ABI tuple.
//
// USDFC is ERC-20 only; only 0x / t410f recipients are valid.
//
// On-chain verification: after each send we re-read the recipient's
// balance and compare delta. For 0x addresses we use viem.getBalance
// (or erc20 balanceOf for USDFC); for native Filecoin addresses we
// fall through to Glif's `Filecoin.WalletBalance` JSON-RPC.

import {
  type Address,
  type WalletClient,
  type PublicClient,
  parseEther,
  parseUnits,
  formatEther,
  formatUnits,
  http,
  createPublicClient,
  createWalletClient,
  toHex,
  erc20Abi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { filecoinCalibration } from 'viem/chains'
import type { FaucetConfig } from './config.js'
import type { RecipientShape } from './fil-address.js'

// The CallActor precompile at 0xfe00...0003 only behaves correctly when
// invoked via DELEGATECALL from a contract context. Calling it directly
// from an EOA (which is what wallet.sendTransaction does) returns
// status=success but silently keeps msg.value at the precompile's own
// account. We therefore route native sends through a tiny forwarder
// contract (deployed on Calibration at the address in cfg.CALL_ACTOR_FORWARDER)
// whose only job is to delegatecall the precompile with the right calldata.
// See contracts/CallActorForwarder.sol.
const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'sendFil',
    stateMutability: 'payable',
    inputs: [{ name: 'target', type: 'bytes' }],
    outputs: [],
  },
] as const
const USDFC_DECIMALS = 18

export interface DripResult {
  txHash: `0x${string}`
  amount: string
  asset: 'fil' | 'usdfc'
  recipientBalanceBefore: string
  recipientBalanceAfter: string
  verified: boolean
  /** Whether the send was routed through the CallActor precompile (vs a plain ETH transfer). */
  nativeFilSend?: boolean
}

export interface DispenserState {
  address: Address
  filBalance: bigint
  usdfcBalance: bigint
}

export class Drip {
  private cfg: FaucetConfig
  private wallet: WalletClient
  private pub: PublicClient
  private dispenser: Address

  constructor(cfg: FaucetConfig) {
    this.cfg = cfg
    const account = privateKeyToAccount(cfg.FAUCET_PK)
    this.dispenser = account.address
    this.pub = createPublicClient({
      chain: filecoinCalibration,
      transport: http(cfg.RPC_URL),
    })
    this.wallet = createWalletClient({
      account,
      chain: filecoinCalibration,
      transport: http(cfg.RPC_URL),
    })
  }

  get dispenserAddress(): Address {
    return this.dispenser
  }

  async state(): Promise<DispenserState> {
    const [filBalance, usdfcBalance] = await Promise.all([
      this.pub.getBalance({ address: this.dispenser }),
      this.pub.readContract({
        address: this.cfg.USDFC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [this.dispenser],
      }) as Promise<bigint>,
    ])
    return { address: this.dispenser, filBalance, usdfcBalance }
  }

  async checkReserves(asset: 'fil' | 'usdfc'): Promise<string | null> {
    const state = await this.state()
    if (asset === 'fil') {
      const minFil = parseEther(this.cfg.MIN_RESERVE_FIL)
      const dripFil = parseEther(this.cfg.FIL_DRIP)
      if (state.filBalance < minFil + dripFil) {
        return `dispenser tFIL low: ${formatEther(state.filBalance)} (reserve ${this.cfg.MIN_RESERVE_FIL} + drip ${this.cfg.FIL_DRIP})`
      }
    } else {
      const minUsdfc = parseUnits(this.cfg.MIN_RESERVE_USDFC, USDFC_DECIMALS)
      const dripUsdfc = parseUnits(this.cfg.USDFC_DRIP, USDFC_DECIMALS)
      if (state.usdfcBalance < minUsdfc + dripUsdfc) {
        return `dispenser USDFC low: ${formatUnits(state.usdfcBalance, USDFC_DECIMALS)} (reserve ${this.cfg.MIN_RESERVE_USDFC} + drip ${this.cfg.USDFC_DRIP})`
      }
    }
    return null
  }

  /** Drip tFIL to whatever address shape we have (eth, delegated, or native). */
  async dripFil(recipient: RecipientShape): Promise<DripResult> {
    const amount = parseEther(this.cfg.FIL_DRIP)

    if (recipient.kind === 'eth' || recipient.kind === 'delegated') {
      const target = recipient.kind === 'eth' ? recipient.address : recipient.address
      const before = await this.pub.getBalance({ address: target })
      const txHash = await this.wallet.sendTransaction({
        to: target,
        value: amount,
        account: this.wallet.account!,
        chain: filecoinCalibration,
      })
      await this.pub.waitForTransactionReceipt({ hash: txHash })
      const after = await this.pub.getBalance({ address: target })
      return {
        txHash,
        amount: this.cfg.FIL_DRIP,
        asset: 'fil',
        recipientBalanceBefore: before.toString(),
        recipientBalanceAfter: after.toString(),
        verified: after - before >= amount,
      }
    }

    if (recipient.kind === 'filecoin') {
      // Route through the forwarder contract; the forwarder delegatecalls
      // the CallActor precompile so the cross-actor send has a proper
      // contract context (the forwarder's f410f becomes the from-actor).
      const before = await filecoinWalletBalance(this.cfg.RPC_URL, recipient.original)

      // Pre-flight: simulate the contract call so a malformed encoding
      // reverts cheaply instead of silently keeping the value.
      await this.pub.simulateContract({
        address: this.cfg.CALL_ACTOR_FORWARDER,
        abi: FORWARDER_ABI,
        functionName: 'sendFil',
        args: [toHex(recipient.bytes)],
        value: amount,
        account: this.wallet.account!,
      })

      const txHash = await this.wallet.writeContract({
        address: this.cfg.CALL_ACTOR_FORWARDER,
        abi: FORWARDER_ABI,
        functionName: 'sendFil',
        args: [toHex(recipient.bytes)],
        value: amount,
        account: this.wallet.account!,
        chain: filecoinCalibration,
      })
      await this.pub.waitForTransactionReceipt({ hash: txHash })

      const after = await filecoinWalletBalance(this.cfg.RPC_URL, recipient.original)
      return {
        txHash,
        amount: this.cfg.FIL_DRIP,
        asset: 'fil',
        recipientBalanceBefore: before.toString(),
        recipientBalanceAfter: after.toString(),
        verified: after - before >= amount,
        nativeFilSend: true,
      }
    }

    throw new Error(`unsupported recipient kind: ${(recipient as { kind: string }).kind}`)
  }

  /** Drip USDFC. Only 0x / delegated recipients (it's ERC-20). */
  async dripUsdfc(recipient: RecipientShape): Promise<DripResult> {
    if (recipient.kind !== 'eth' && recipient.kind !== 'delegated') {
      throw new Error('USDFC only supports 0x / t410f recipients')
    }
    const target = recipient.kind === 'eth' ? recipient.address : recipient.address
    const amount = parseUnits(this.cfg.USDFC_DRIP, USDFC_DECIMALS)
    const before = (await this.pub.readContract({
      address: this.cfg.USDFC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [target],
    })) as bigint
    const txHash = await this.wallet.writeContract({
      address: this.cfg.USDFC_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [target, amount],
      account: this.wallet.account!,
      chain: filecoinCalibration,
    })
    await this.pub.waitForTransactionReceipt({ hash: txHash })
    const after = (await this.pub.readContract({
      address: this.cfg.USDFC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [target],
    })) as bigint
    return {
      txHash,
      amount: this.cfg.USDFC_DRIP,
      asset: 'usdfc',
      recipientBalanceBefore: before.toString(),
      recipientBalanceAfter: after.toString(),
      verified: after - before >= amount,
    }
  }
}

async function filecoinWalletBalance(rpcUrl: string, addr: string): Promise<bigint> {
  // Filecoin native RPC; works for any address shape (t0/t1/t3/t4).
  // Returns the balance as an attoFIL string.
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'Filecoin.WalletBalance', params: [addr] }),
  })
  if (!res.ok) return 0n
  const data = (await res.json()) as { result?: string; error?: unknown }
  if (data.error || !data.result) return 0n
  return BigInt(data.result)
}
