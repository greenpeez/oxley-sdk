import { encodeFunctionData, type Address, type Hex } from "viem";
import { auctionBidRouterAbi, ccaAuctionAbi } from "./auction-abis.js";
import { tokenAbi } from "./abis.js";
import { address, check, hash, uint } from "./validation.js";
import type { Transaction } from "./types.js";

export interface AuctionBidInput {
  dealId: Hex;
  /** Six-decimal quote-token base units, interpreted by the router's fee mode. */
  entered: bigint;
  /** Native CCA Q96 price: quote base units per token base unit. */
  maxPriceQ96: bigint;
  previousTick: bigint;
  /** Unix seconds; unlike CCA checkpoint hints, this is not a block number. */
  deadline: bigint;
}
export interface PartialFillHints {
  /** CCA checkpoint numbers, not receipt/event block numbers. */
  lastFullyFilledCheckpointBlock: bigint;
  /** Zero only for the final-clearing-price equality case. */
  outbidBlock: bigint;
}
function chain(value: number) {
  check(Number.isSafeInteger(value) && value > 0, "INVALID_CHAIN", "A positive chain ID is required");
}
export function bidInputs(input: AuctionBidInput) {
  hash(input.dealId); uint(input.entered); uint(input.maxPriceQ96);
  uint(input.previousTick, false); uint(input.deadline);
  check(input.entered < 1n << 128n, "INVALID_AMOUNT", "Bid input must fit uint128");
}
/** Low-level encoder: callers must independently verify bindings, hints and current state. */
export function buildAuctionBid(input: AuctionBidInput & { chainId: number; bidRouter: Address }): Transaction {
  chain(input.chainId); address(input.bidRouter); bidInputs(input);
  return { chainId: input.chainId, to: input.bidRouter, value: 0n, data: encodeFunctionData({
    abi: auctionBidRouterAbi, functionName: "submitBid",
    args: [input.dealId, input.maxPriceQ96, input.entered, input.previousTick, input.deadline],
  }) };
}
export function buildAuctionClaim(input: { chainId: number; auction: Address; bidId: bigint }): Transaction {
  chain(input.chainId); address(input.auction); uint(input.bidId, false);
  return { chainId: input.chainId, to: input.auction, value: 0n, data: encodeFunctionData({
    abi: ccaAuctionAbi, functionName: "claimTokens", args: [input.bidId],
  }) };
}
/** Exit a failed/full-fill bid, or explicitly supply partial-fill checkpoint hints. */
export function buildAuctionRefund(input: {
  chainId: number; auction: Address; bidId: bigint; partialFill?: PartialFillHints;
}): Transaction {
  chain(input.chainId); address(input.auction); uint(input.bidId, false);
  if (input.partialFill !== undefined) {
    const { lastFullyFilledCheckpointBlock: last, outbidBlock: outbid } = input.partialFill;
    uint(last, false); uint(outbid, false);
    check(last < 1n << 64n && outbid < 1n << 64n, "INVALID_HINT", "CCA checkpoint hints must fit uint64");
    return { chainId: input.chainId, to: input.auction, value: 0n, data: encodeFunctionData({
      abi: ccaAuctionAbi, functionName: "exitPartiallyFilledBid", args: [input.bidId, last, outbid],
    }) };
  }
  return { chainId: input.chainId, to: input.auction, value: 0n, data: encodeFunctionData({
    abi: ccaAuctionAbi, functionName: "exitBid", args: [input.bidId],
  }) };
}
export function buildAuctionBidApprovals(input: {
  chainId: number; quoteToken: Address; bidRouter: Address; debit: bigint; currentAllowance: bigint;
}): readonly Transaction[] {
  chain(input.chainId); address(input.quoteToken); address(input.bidRouter);
  uint(input.debit); uint(input.currentAllowance, false);
  if (input.currentAllowance >= input.debit) return [];
  return (input.currentAllowance > 0n ? [0n, input.debit] : [input.debit]).map(amount => ({
    chainId: input.chainId, to: input.quoteToken, value: 0n, data: encodeFunctionData({
      abi: tokenAbi, functionName: "approve", args: [input.bidRouter, amount],
    }),
  }));
}
