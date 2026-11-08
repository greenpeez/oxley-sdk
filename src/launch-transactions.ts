import { encodeFunctionData, type Address, type Hex } from "viem";
import { tokenAbi } from "./abis.js";
import { creatorAccountAbi, creatorAccountFactoryAbi } from "./launch-abis.js";
import { checkDurationBlocks } from "./launch-duration.js";
import { validateLaunchTerms } from "./launch-input.js";
import { address, check, hash, uint } from "./validation.js";
import type { Transaction } from "./types.js";
import type { AuctionLaunchInput, LaunchTransaction } from "./launch-types.js";

function chain(value: number) { check(Number.isSafeInteger(value) && value > 0, "INVALID_CHAIN", "A positive chain ID is required"); }
/** Factory `createAccountForDraft(draftSalt, beneficiary)`: deploys the single-launch creator account for `msg.sender` and registers it with the controller. */
export function buildCreatorAccount(input: { chainId: number; factory: Address; draftSalt: Hex; beneficiary: Address }): Transaction {
  chain(input.chainId); address(input.factory); hash(input.draftSalt); address(input.beneficiary);
  return { chainId: input.chainId, to: input.factory, value: 0n, data: encodeFunctionData({
    abi: creatorAccountFactoryAbi, functionName: "createAccountForDraft", args: [input.draftSalt, input.beneficiary] }) };
}
/**
 * Approvals for the launch fee. The spender is the creator account (it pulls the fee), never the controller. A nonzero allowance below the fee is reset
 * to zero first, as for bids; an allowance that already covers the fee needs none.
 */
export function buildLaunchApprovals(input: { chainId: number; quoteToken: Address; creatorAccount: Address; launchFee: bigint; currentAllowance: bigint }): readonly Transaction[] {
  chain(input.chainId); address(input.quoteToken); address(input.creatorAccount); uint(input.launchFee); uint(input.currentAllowance, false);
  if (input.currentAllowance >= input.launchFee) return [];
  return (input.currentAllowance > 0n ? [0n, input.launchFee] : [input.launchFee]).map(amount => ({
    chainId: input.chainId, to: input.quoteToken, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [input.creatorAccount, amount] }) }));
}
/**
 * The launch call on the creator account. `value` is the creator's native operating bond (0.5 HYPE), which the controller requires exactly and the bond
 * escrow holds for the auction's delivery and refund gas. `gasPrice`, when given, is the price the step was simulated at.
 */
export function buildAuctionLaunch(input: Omit<AuctionLaunchInput, "owner" | "draftSalt" | "beneficiary" | "secondsPerBlock" | "durationBlocks">
  & { chainId: number; creatorAccount: Address; durationBlocks: number; bondWei: bigint; gasPrice?: bigint }): LaunchTransaction {
  chain(input.chainId); address(input.creatorAccount); uint(input.bondWei);
  validateLaunchTerms(input); checkDurationBlocks(input.auctionDurationHours, input.durationBlocks);
  return { chainId: input.chainId, to: input.creatorAccount, value: input.bondWei, ...input.gasPrice === undefined ? {} : { gasPrice: input.gasPrice },
    data: encodeFunctionData({ abi: creatorAccountAbi, functionName: "launchAuctionWithCommitmentAndExactDuration",
      args: [input.name, input.symbol, input.floorPriceWad, input.creatorLockDays, input.listingCommitmentBps, input.auctionDurationHours, input.durationBlocks] }) };
}
