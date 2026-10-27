import type { Address, Hex, PublicClient } from "viem";
import type { AuctionDeployment } from "./auctions.js";
import type { ContractPin, RpcClient, Transaction } from "./types.js";

export type LaunchRpcClient = RpcClient & Pick<PublicClient, "getBalance" | "getTransactionCount" | "getGasPrice">;
export interface LaunchDeployment extends AuctionDeployment {
  launchBindings: {
    creatorAccountFactory: ContractPin;
    entryController: ContractPin;
    bondEscrow: ContractPin;
    launchFeeBaseUnits: string;
    deployerBondWei: string;
  };
}
export interface AuctionLaunchInput {
  /** Stable, nonzero identity. Persist it before any transaction and reuse on retry. */
  dealId: Hex;
  owner: Address;
  name: string;
  symbol: string;
  /** Deployed adapter's price scale, not parseUnits(price, 18). See quoteAuctionFloor. */
  floorPriceWad: bigint;
  creatorLockDays: 0 | 30 | 60;
  listingCommitmentBps: 5000 | 10000;
  auctionDurationHours: number;
  /** Gen2 only: observed seconds per block, converting the hours into an exact CCA length. */
  secondsPerBlock?: number;
  /** Gen2 only: explicit CCA length within auctionDurationBounds(hours); takes precedence over secondsPerBlock. */
  durationBlocks?: number;
}
/** Only launch carries native value; swaps and bids retain Transaction.value = 0n. */
export interface AuctionLaunchTransaction extends Omit<Transaction, "value"> { readonly value: bigint; readonly gasPrice?: bigint }
