import type { Address, Hex, PublicClient } from "viem";
import type { RpcClient, Transaction } from "./types.js";

/** The public client the launch client needs: the shared reads plus the wallet's native balance, pending nonce and the chain's gas price. */
export type LaunchRpcClient = RpcClient & Pick<PublicClient, "getBalance" | "getTransactionCount" | "getGasPrice">;
/** The launch step carries native value (the operating bond) and the gas price it was simulated at; every other transaction in the SDK has `value: 0n`. */
export interface LaunchTransaction extends Omit<Transaction, "value"> { readonly value: bigint; readonly gasPrice?: bigint }
export type LaunchStage = "terms" | "setup" | "reset" | "approve" | "launch";

export interface AuctionLaunchInput {
  /** The creator wallet. It signs every step, becomes the creator account's controller and is the only account that can claim the unused bond back. */
  owner: Address;
  /**
   * A nonzero random bytes32 chosen once and persisted with these terms (`newDraftSalt()`). The deal id is derived from it and the owner (`launchDealId`);
   * reuse the same salt after reloads, timeouts and retries so the same creator account is resumed, never a second one.
   */
  draftSalt: Hex;
  /** Receives the creator's trading-fee share. Defaults to the owner. */
  beneficiary?: Address;
  /** Trimmed, 1 to 80 UTF-8 bytes. */
  name: string;
  /** 1 to 10 uppercase ASCII letters or digits; OXY is reserved. */
  symbol: string;
  /** The adapter's price scale: 24 decimal places for a human USDC-per-coin price. Checked by `validateLaunchFloor`. */
  floorPriceWad: bigint;
  creatorLockDays: 0 | 30 | 60;
  listingCommitmentBps: 0 | 5000 | 10000;
  /** Whole hours, 1 to 24. */
  auctionDurationHours: number;
  /** An explicit CCA length within `auctionDurationBounds(hours)`; takes precedence over `secondsPerBlock`. */
  durationBlocks?: number;
  /** The observed block rate that converts the hours into blocks. Omit both to sample the chain (`sampleSecondsPerBlock`). */
  secondsPerBlock?: number;
}
