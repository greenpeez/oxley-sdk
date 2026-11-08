import type { Address, Hex, PublicClient } from "viem";
import type { BID_RULES } from "./bid-rules.js";

export type RpcClient = Pick<PublicClient, "getChainId" | "getBlock" | "getCode" | "readContract" | "getLogs" | "call" | "estimateGas">;
export interface ContractPin { readonly address: Address; readonly runtimeCodeHash: Hex }
/**
 * What the launch client pins beyond the auction graph: the creator account factory (creator accounts are deployed by it, so the account itself has no pin), the
 * entry controller and the bond escrow, and the two costs of a launch. Both are verified against the chain by the launch client's `verifyDeployment`.
 */
export interface LaunchBindings {
  readonly creatorAccountFactory: ContractPin;
  /** Pauses new launches (`entriesPaused`). */
  readonly entryController: ContractPin;
  /** Holds the creator's native operating bond and repays the gas of settlement operations from it. */
  readonly bondEscrow: ContractPin;
  /** The controller's `launchFee()` in quote-token base units (1.5 USDC: 1500000). */
  readonly launchFeeBaseUnits: string;
  /** The native value a launch carries as the creator's operating bond, in wei (0.5 HYPE; the bond escrow's `CREATOR_DEPOSIT`). */
  readonly deployerBondWei: string;
}
/**
 * The reviewed deployment manifest: every contract the clients read, pinned by address and runtime code hash. The curve and the Dynamic Bids hook
 * enforce the terms registry, the controller caps the launch floor and requires a 30,000 USDC net minimum raise, `launchBindings` pin the launch
 * contracts (only the launch client needs them, so a trading or auction manifest may omit them; when present they are validated in full), and `bidRules`
 * are the exact compiled per-wallet bid rules (all verified against the chain by `verifyDeployment`).
 */
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
  /** The end-user terms registry the curve and the Dynamic Bids hook enforce. */
  readonly termsRegistry: ContractPin;
  readonly auctionBindings: {
    readonly controllerRuntimeCodeHash: Hex;
    readonly bidRouter: ContractPin;
    readonly adapter: ContractPin;
    /** The Dynamic Bids hook. */
    readonly bidHook: ContractPin;
    readonly exposureHelper: ContractPin;
  };
  /** Required by `createOxleyLaunchClient` only (see `LaunchDeployment`); optional for the trading and auction clients. */
  readonly launchBindings?: LaunchBindings;
  /** The exact compiled bid rules; any other value is refused. */
  readonly bidRules: typeof BID_RULES;
  /** Informational release status, e.g. "live"; runtime pins remain authoritative. */
  readonly status?: string;
  readonly note?: string;
}
/** A deployment that carries the launch bindings: what `createOxleyLaunchClient` (and `parseLaunchDeployment`) works with. */
export type LaunchDeployment = Deployment & { readonly launchBindings: LaunchBindings };
export interface Anchor { readonly blockNumber: bigint; readonly blockHash: Hex; readonly timestamp: bigint }
export interface Market {
  readonly id: Hex;
  readonly coin: Address;
  readonly coinDecimals: number;
  readonly creator: Address;
  readonly activatedAt: bigint;
  readonly quoteToken: Address;
  readonly curve: Address;
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
   * Buys only: the decaying opening surcharge rate (WAD, 1e18 = 100%) the curve applied at the quote block; it is already inside
   * `feeAmount`. Execution happens later, so the charged rate can only be lower.
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
