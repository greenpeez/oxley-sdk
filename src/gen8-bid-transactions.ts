import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, parseAbiParameters, type Address, type Hex } from "viem";
import { gen8BidRouterAbi } from "./gen8-abis.js";
import { GEN8_MAX_WALLET_BIDS, GEN8_MIN_BID } from "./gen8-bid-rules.js";
import { address, check, hash, uint } from "./validation.js";
import type { Transaction } from "./types.js";

/** `lastFull`: latest checkpoint below the bid's price. `outbid`: first checkpoint above it (0 = the latest checkpoint). */
export interface BidWitness { lastFull: bigint; outbid: bigint }
export interface DynamicBidInput {
  dealId: Hex; maxPriceQ96: bigint; previousTick: bigint;
  /** Unix seconds. */
  deadline: bigint;
  /** Pre-fee Oxy-USDC base units, at least 20. */
  entered: bigint;
  /** One witness per bid the wallet already has stored on this auction, oldest first. */
  witnesses: readonly BidWitness[];
}
const witnessList = parseAbiParameters("(uint64 lastFull,uint64 outbid)[] witnesses");
const u64 = (value: bigint) => { uint(value, false); check(value < 1n << 64n, "INVALID_HINT", "Checkpoint hints must fit uint64"); };

/** The router's `data`: `abi.encode(BidWitness[])`, which the hook re-reads at validation. No credential or signature exists. */
export function encodeBidWitnesses(witnesses: readonly BidWitness[]): Hex {
  check(witnesses.length <= GEN8_MAX_WALLET_BIDS, "INVALID_HINT", "A wallet has at most 12 bids on an auction");
  for (const { lastFull, outbid } of witnesses) { u64(lastFull); u64(outbid); }
  return encodeAbiParameters(witnessList, [witnesses.map(({ lastFull, outbid }) => ({ lastFull, outbid }))]);
}
/** Inverse of {@link encodeBidWitnesses}; rejects anything that is not exactly `abi.encode(BidWitness[])` with at most 12 entries. */
export function decodeBidWitnesses(data: Hex): BidWitness[] {
  const [rows] = decodeAbiParameters(witnessList, data);
  const witnesses = rows.map(({ lastFull, outbid }) => ({ lastFull: BigInt(lastFull), outbid: BigInt(outbid) }));
  check(encodeBidWitnesses(witnesses) === data.toLowerCase(), "INVALID_HINT", "Not a canonical witness list");
  return witnesses;
}
function checked(input: DynamicBidInput): void {
  hash(input.dealId); uint(input.maxPriceQ96); uint(input.previousTick, false); uint(input.deadline); uint(input.entered);
  check(input.entered >= GEN8_MIN_BID && input.entered < 1n << 128n, "BID_TOO_LOW", "A Dynamic Bid is at least 20 Oxy-USDC and fits uint128");
}
const send = (chainId: number, bidRouter: Address, data: Hex): Transaction => ({ chainId, to: bidRouter, value: 0n, data });
function chain(chainId: number, bidRouter: Address): void {
  check(Number.isSafeInteger(chainId) && chainId > 0, "INVALID_CHAIN", "A positive chain ID is required"); address(bidRouter);
}

/** `submitBid(id, maxPrice, entered, previousTick, deadline, witnesses)` on the accepted-bid router. */
export function buildDynamicBid(input: DynamicBidInput & { chainId: number; bidRouter: Address }): Transaction {
  chain(input.chainId, input.bidRouter); checked(input);
  return send(input.chainId, input.bidRouter, encodeFunctionData({ abi: gen8BidRouterAbi, functionName: "submitBid",
    args: [input.dealId, input.maxPriceQ96, input.entered, input.previousTick, input.deadline, encodeBidWitnesses(input.witnesses)] }));
}
/** Exits the caller's outbid `oldBidId` and bids again in one transaction; `exit` is the old bid's own witness. */
export function buildDynamicRebid(input: DynamicBidInput & { chainId: number; bidRouter: Address; oldBidId: bigint; exit: BidWitness }): Transaction {
  chain(input.chainId, input.bidRouter); checked(input); uint(input.oldBidId, false); u64(input.exit.lastFull); u64(input.exit.outbid);
  return send(input.chainId, input.bidRouter, encodeFunctionData({ abi: gen8BidRouterAbi, functionName: "rebid",
    args: [input.dealId, input.oldBidId, input.exit, input.maxPriceQ96, input.entered, input.previousTick, input.deadline,
      encodeBidWitnesses(input.witnesses)] }));
}
