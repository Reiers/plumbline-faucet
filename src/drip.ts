// SPDX-License-Identifier: MIT
//
// Drip executor: sends tFIL and USDFC to a recipient on Filecoin
// Calibration. Each call is sequenced (not parallel) to avoid nonce
// races; tFIL is sent first because if it fails we don't bother with
// the USDFC mint at all.

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
  filTxHash: `0x${string}`
  usdfcTxHash: `0x${string}`
  filAmount: string
  usdfcAmount: string
}

export interface DispenserState {
  address: Address
  filBalance: bigint
  usdfcBalance: bigint
}

const USDFC_DECIMALS = 18 // USDFC on Calibration is 18 decimals

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

  /**
   * Pre-flight: verify the dispenser has enough headroom to honor a drip
   * AND keep its configured reserves. Returns null if OK, otherwise a
   * human-readable reason string.
   */
  async checkReserves(): Promise<string | null> {
    const state = await this.state()
    const minFil = parseEther(this.cfg.MIN_RESERVE_FIL)
    const minUsdfc = parseUnits(this.cfg.MIN_RESERVE_USDFC, USDFC_DECIMALS)
    const dripFil = parseEther(this.cfg.FIL_DRIP)
    const dripUsdfc = parseUnits(this.cfg.USDFC_DRIP, USDFC_DECIMALS)

    if (state.filBalance < minFil + dripFil) {
      return `dispenser tFIL low: ${formatEther(state.filBalance)} (reserve ${this.cfg.MIN_RESERVE_FIL} + drip ${this.cfg.FIL_DRIP})`
    }
    if (state.usdfcBalance < minUsdfc + dripUsdfc) {
      return `dispenser USDFC low: ${formatUnits(state.usdfcBalance, USDFC_DECIMALS)} (reserve ${this.cfg.MIN_RESERVE_USDFC} + drip ${this.cfg.USDFC_DRIP})`
    }
    return null
  }

  async drip(recipient: Address): Promise<DripResult> {
    const filAmount = parseEther(this.cfg.FIL_DRIP)
    const usdfcAmount = parseUnits(this.cfg.USDFC_DRIP, USDFC_DECIMALS)

    // 1. tFIL transfer (native)
    const filTxHash = await this.wallet.sendTransaction({
      to: recipient,
      value: filAmount,
      account: this.wallet.account!,
      chain: filecoinCalibration,
    })
    await this.pub.waitForTransactionReceipt({ hash: filTxHash })

    // 2. USDFC ERC-20 transfer
    const usdfcTxHash = await this.wallet.writeContract({
      address: this.cfg.USDFC_ADDRESS,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, usdfcAmount],
      account: this.wallet.account!,
      chain: filecoinCalibration,
    })
    await this.pub.waitForTransactionReceipt({ hash: usdfcTxHash })

    return {
      filTxHash,
      usdfcTxHash,
      filAmount: this.cfg.FIL_DRIP,
      usdfcAmount: this.cfg.USDFC_DRIP,
    }
  }
}
