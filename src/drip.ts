// SPDX-License-Identifier: MIT
//
// Drip executor: sends tFIL OR USDFC to a recipient on Filecoin
// Calibration. Each asset is its own method so callers can drip them
// independently (the public faucet UI splits them across two panels).
//
// After every send we verify on-chain that the recipient's balance
// actually moved by the expected amount. Belt-and-suspenders against
// RPC inconsistencies, mempool reorgs, or partial-include cases.

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
  erc20Abi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { filecoinCalibration } from 'viem/chains'
import type { FaucetConfig } from './config.js'

export interface DripResult {
  txHash: `0x${string}`
  amount: string
  asset: 'fil' | 'usdfc'
  recipientBalanceBefore: string
  recipientBalanceAfter: string
  verified: boolean
}

export interface DispenserState {
  address: Address
  filBalance: bigint
  usdfcBalance: bigint
}

const USDFC_DECIMALS = 18

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

  async dripFil(recipient: Address): Promise<DripResult> {
    const amount = parseEther(this.cfg.FIL_DRIP)
    const before = await this.pub.getBalance({ address: recipient })
    const txHash = await this.wallet.sendTransaction({
      to: recipient,
      value: amount,
      account: this.wallet.account!,
      chain: filecoinCalibration,
    })
    await this.pub.waitForTransactionReceipt({ hash: txHash })
    const after = await this.pub.getBalance({ address: recipient })
    return {
      txHash,
      amount: this.cfg.FIL_DRIP,
      asset: 'fil',
      recipientBalanceBefore: before.toString(),
      recipientBalanceAfter: after.toString(),
      verified: after - before >= amount,
    }
  }

  async dripUsdfc(recipient: Address): Promise<DripResult> {
    const amount = parseUnits(this.cfg.USDFC_DRIP, USDFC_DECIMALS)
    const before = (await this.pub.readContract({
      address: this.cfg.USDFC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [recipient],
    })) as bigint
    const txHash = await this.wallet.writeContract({
      address: this.cfg.USDFC_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, amount],
      account: this.wallet.account!,
      chain: filecoinCalibration,
    })
    await this.pub.waitForTransactionReceipt({ hash: txHash })
    const after = (await this.pub.readContract({
      address: this.cfg.USDFC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [recipient],
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
