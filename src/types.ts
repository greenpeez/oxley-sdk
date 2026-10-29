import type { Address, Hex, PublicClient } from "viem";

export type RpcClient = Pick<PublicClient, "getChainId" | "getBlock" | "getCode" | "readContract" | "getLogs" | "call" | "estimateGas">;
export interface ContractPin { readonly address: Address; readonly runtimeCodeHash: Hex }
/**
 * Contract generation of a release. An absent manifest field means the deployed flat-fee release. Gen3 and Gen8 curves also
 * require the caller to have accepted the terms in the bound terms registry; Gen8 is the quote-only curve with Dynamic Bids.
 */
export type DeploymentGeneration = "flat-fee" | "gen2" | "gen3" | "gen8";
export interface Deployment {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly chainId: number;
  readonly network: "testnet" | "mainnet";
  readonly startBlock: string;
  readonly curve: ContractPin;
  readonly registry: ContractPin;
  readonly quoteToken: ContractPin & { readonly symbol: "USDC" | "Oxy-USDC"; readonly decimals: 6 };
  readonly auctionController: Address;
  /** Absent: flat-fee. "gen2": exact-duration launches, breadth bid rule and trading gate. "gen3"/"gen8": terms-gated curves. */
  readonly generation?: DeploymentGeneration;
  /** Required exactly for "gen3" and "gen8": the end-user terms registry the curve (and the Gen8 bid hook) enforces. */
  readonly termsRegistry?: ContractPin;
  /** Informational release status, e.g. "planned-fork-addresses"; runtime pins remain authoritative. */
  readonly status?: string;
  readonly note?: string;
}
export interface Anchor { readonly blockNumber: bigint; readonly blockHash: Hex; readonly timestamp: bigint }
export interface Market {
  readonly id: Hex;
  readonly coin: Address;
  readonly coinDecimals: number;
  readonly creator: Address;
  readonly activatedAt: bigint;
  readonly quoteToken: Address;
  readonly curve: Address;
  /** Contract generation of the curve that holds the market; absent on hand-built markets, which mean flat-fee. */
  readonly generation?: DeploymentGeneration;
}
export interface QuoteRequest {
  marketId: Hex;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Address actually calling the curve: wallet or provider executor. */
  caller: Address;
  blockNumber?: bigint;
}
export interface Quote extends Anchor {
  readonly chainId: number;
  readonly releaseId: string;
  readonly market: Market;
  readonly side: "buy" | "sell";
  readonly caller: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Fee is always in quote-token base units, including sells. */
  readonly feeAmount: bigint;
  readonly feeToken: Address;
  /**
   * Gen3/Gen8 buys: the decaying opening surcharge rate (WAD, 1e18 = 100%) the curve applied at the quote block; it is already
   * inside `feeAmount`. Execution happens later, so the charged rate can only be lower. Absent for other quotes.
   */
  readonly openingSurchargeWad?: bigint;
}
export interface Transaction {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
}
export interface Swap {
  readonly quote: Quote;
  readonly transaction: Transaction;
  readonly allowance: { readonly token: Address; readonly owner: Address; readonly spender: Address; readonly amount: bigint };
  readonly minAmountOut: bigint;
  readonly deadline: bigint;
  readonly amountInOffset: 36;
  readonly outputReceiver: Address;
  readonly rewardBeneficiary: Address;
}
export interface DiscoveryCursor {
  readonly chainId: number;
  readonly releaseId: string;
  readonly curve: Address;
  readonly blockNumber: string;
  readonly blockHash: Hex;
}
