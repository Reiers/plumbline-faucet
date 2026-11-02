// SPDX-License-Identifier: MIT
//
// Mainnet dispenser: viem bindings against Filecoin mainnet (chain 314)
// and the mainnet USDFC ERC-20.
//
// Recipients are 0x addresses only (f410f is converted to 0x by the
// caller). Native f1/f3/f0 sends need the CallActor forwarder, which is
// only deployed on Calibration, so the preview does not support them.
//
// Every live send is simulated first (eth_call for USDFC transfer,
// eth_estimateGas for FIL), then signed and broadcast. Receipts are
// awaited separately so the single-flight queue is only held for the
// broadcast. In dry-run mode the simulation is the whole send: no
// transaction is ever signed or broadcast.

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { filecoin } from 'viem/chains'
import type { MainnetAsset, MainnetConfig } from './config.js'

export interface Balances {
  /** attoFIL */
  fil: bigint
  /** USDFC base units (18 decimals) */
  usdfc: bigint
}

export interface BroadcastResult {
  /** Null when simulated (dry run). */
  txHash: Hex | null
  simulated: boolean
  gasEstimate: bigint
}

export type ReceiptStatus = 'confirmed' | 'reverted' | 'pending'

export interface MainnetDispenserLike {
  readonly address: Address
  readonly dryRun: boolean
  chainId(): Promise<number>
  balances(): Promise<Balances>
  simulate(asset: MainnetAsset, to: Address, amountWei: bigint): Promise<{ gas: bigint }>
  /** Simulate, then sign and broadcast (live) or stop after simulation (dry run). */
  broadcast(asset: MainnetAsset, to: Address, amountWei: bigint): Promise<BroadcastResult>
  /** Wait up to timeoutMs for a receipt. 'pending' means not seen yet. */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<ReceiptStatus>
}

export class MainnetDispenser implements MainnetDispenserLike {
  readonly address: Address
  readonly dryRun: boolean
  private pub: PublicClient
  private wallet: WalletClient | null
  private account: PrivateKeyAccount | null
  private usdfc: Address

  constructor(cfg: Pick<MainnetConfig, 'rpcUrl' | 'usdfcAddress' | 'privateKey' | 'dryRun' | 'dryRunAddress'>) {
    this.dryRun = cfg.dryRun
    this.usdfc = cfg.usdfcAddress
    const transport = http(cfg.rpcUrl, { retryCount: 2, timeout: 30_000 })
    this.pub = createPublicClient({ chain: filecoin, transport }) as PublicClient
    if (cfg.privateKey) {
      this.account = privateKeyToAccount(cfg.privateKey)
      this.wallet = cfg.dryRun ? null : createWalletClient({ account: this.account, chain: filecoin, transport })
    } else {
      this.account = null
      this.wallet = null
    }
    // In dry-run, a watch-only address can stand in for the dispenser so
    // the full policy can be exercised against a real funded mainnet
    // holder without any key on the box.
    const addr = cfg.dryRun && cfg.dryRunAddress ? cfg.dryRunAddress : this.account?.address
    if (!addr) throw new Error('dispenser has neither a key nor a dry-run address')
    this.address = addr
  }

  async chainId(): Promise<number> {
    return this.pub.getChainId()
  }

  async balances(): Promise<Balances> {
    const [fil, usdfc] = await Promise.all([
      this.pub.getBalance({ address: this.address }),
      this.pub.readContract({ address: this.usdfc, abi: erc20Abi, functionName: 'balanceOf', args: [this.address] }),
    ])
    return { fil, usdfc: usdfc as bigint }
  }

  async tokenInfo(): Promise<{ symbol: string; decimals: number; name: string }> {
    const [symbol, decimals, name] = await Promise.all([
      this.pub.readContract({ address: this.usdfc, abi: erc20Abi, functionName: 'symbol' }),
      this.pub.readContract({ address: this.usdfc, abi: erc20Abi, functionName: 'decimals' }),
      this.pub.readContract({ address: this.usdfc, abi: erc20Abi, functionName: 'name' }),
    ])
    return { symbol: symbol as string, decimals: Number(decimals), name: name as string }
  }

  async simulate(asset: MainnetAsset, to: Address, amountWei: bigint): Promise<{ gas: bigint }> {
    if (asset === 'usdfc') {
      const { result } = await this.pub.simulateContract({
        address: this.usdfc,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amountWei],
        account: this.address,
      })
      if (result !== true) throw new Error('USDFC transfer simulation returned false')
      const gas = await this.pub.estimateContractGas({
        address: this.usdfc,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amountWei],
        account: this.address,
      })
      return { gas }
    }
    const gas = await this.pub.estimateGas({ account: this.address, to, value: amountWei })
    return { gas }
  }

  async broadcast(asset: MainnetAsset, to: Address, amountWei: bigint): Promise<BroadcastResult> {
    const { gas } = await this.simulate(asset, to, amountWei)
    if (this.dryRun || !this.wallet || !this.account) {
      return { txHash: null, simulated: true, gasEstimate: gas }
    }
    // Nonce comes from eth_getTransactionCount(..., 'pending'), which
    // Lotus answers from the mpool, so back-to-back broadcasts from the
    // single-flight queue do not collide.
    const hash =
      asset === 'usdfc'
        ? await this.wallet.writeContract({
            address: this.usdfc,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [to, amountWei],
            account: this.account,
            chain: filecoin,
          })
        : await this.wallet.sendTransaction({ to, value: amountWei, account: this.account, chain: filecoin })
    return { txHash: hash, simulated: false, gasEstimate: gas }
  }

  async waitForReceipt(hash: Hex, timeoutMs: number): Promise<ReceiptStatus> {
    try {
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 5_000 })
      return receipt.status === 'success' ? 'confirmed' : 'reverted'
    } catch {
      return 'pending'
    }
  }
}
