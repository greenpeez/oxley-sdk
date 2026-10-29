import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { tokenAbi } from "./abis.js";
import { ccaAuctionAbi } from "./auction-abis.js";
import { gen8BidHookAbi, ccaCheckpointAbi } from "./gen8-abis.js";
import { termsRegistryAbi } from "./gen3-abis.js";
import { GEN8_BID_RULES, bidsRemaining, liveBids, maximumNewBid, type Gen8Position } from "./gen8-bid-rules.js";
import type { BidWitness } from "./gen8-bid-transactions.js";
import { loadWitnesses } from "./gen8-witnesses.js";
import { address, check, hash, sameAddress } from "./validation.js";
import type { Anchor } from "./types.js";
import type { AuctionContext } from "./auction-context.js";
import type { AuctionReader } from "./auction-state.js";

/** A wallet's standing on one Gen8 auction at one block, as the bid hook will count it. Amounts are Oxy-USDC base units. */
export interface DynamicBidLimits extends Anchor {
  readonly dealId: Hex; readonly auction: Address; readonly owner: Address;
  /** The clearing price after the checkpoint a new bid would take: it decides which bids are outbid. */
  readonly clearingPriceQ96: bigint;
  /** The auction has reached its minimum raise (the CCA's `isGraduated()`): outbid funds can then be exited and rebid. */
  readonly minimumRaiseMet: boolean;
  readonly creatorExcluded: boolean; readonly termsAccepted: boolean;
  readonly minimumBid: bigint;
  /** The hook's `preview`: this wallet's live commitment, its ceiling max(ceil(minimum raise / 10), others / 9), and the room left. */
  readonly committed: bigint; readonly ceiling: bigint; readonly allowance: bigint;
  readonly balance: bigint;
  /** Largest new bid principal: the allowance, bounded by the balance after the 0.1% accepted-bid fee. */
  readonly maximumBid: bigint;
  readonly liveBids: number; readonly bidsLeft: number; readonly positions: readonly Gen8Position[];
  readonly rules: typeof GEN8_BID_RULES;
}
export interface WalletRead { readonly limits: DynamicBidLimits; readonly witnesses: readonly BidWitness[] }

export function createDynamicWallet(context: AuctionContext, auctions: AuctionReader) {
  const { rpc, deployment, anchor, canonical } = context;
  const quote = deployment.quoteToken.address, terms = deployment.termsRegistry?.address;
  async function walletBids(auction: Address, hook: Address, owner: Address, blockNumber: bigint) {
    const base = { address: hook, abi: gen8BidHookAbi, blockNumber } as const;
    const [ids, rule, minimumRaiseMet, projected] = await Promise.all([
      rpc.readContract({ ...base, functionName: "walletBids", args: [auction, owner] }),
      rpc.readContract({ ...base, functionName: "rules", args: [auction] }),
      rpc.readContract({ address: auction, abi: ccaAuctionAbi, functionName: "isGraduated", blockNumber }),
      rpc.call({ to: auction, data: encodeFunctionData({ abi: ccaCheckpointAbi, functionName: "checkpoint" }), blockNumber }),
    ]);
    check(projected.data, "WALLET_STATE_UNAVAILABLE", "The auction checkpoint could not be projected");
    const { clearingPrice } = decodeFunctionResult({ abi: ccaCheckpointAbi, functionName: "checkpoint", data: projected.data });
    const bids = await Promise.all(ids.map(id => rpc.readContract({ address: auction, abi: ccaAuctionAbi, functionName: "bids", args: [id], blockNumber })));
    check(bids.every(bid => sameAddress(bid.owner, owner)), "WALLET_STATE_UNAVAILABLE", "The hook lists a bid owned by another wallet");
    const positions = bids.map((bid, index): Gen8Position => ({ bidId: ids[index]!, amountUnits: bid.amountQ96 >> 96n, maxPriceQ96: bid.maxPrice,
      exited: bid.exitedBlock !== 0n, outbid: bid.maxPrice < clearingPrice }));
    const witnesses = await loadWitnesses(rpc, auction, bids.map((bid, index) => ({ id: ids[index]!, maxPrice: bid.maxPrice, startBlock: bid.startBlock })), blockNumber);
    return { positions, witnesses, clearingPrice, minimumRaiseMet, creatorExcluded: sameAddress(owner, rule[1]) || sameAddress(owner, rule[2]) };
  }
  /** The hook's `preview` checkpoints first, so it is read with `eth_call` given one witness per stored bid. */
  async function previewLimits(auction: Address, hook: Address, owner: Address, witnesses: readonly BidWitness[], blockNumber: bigint) {
    const data = encodeFunctionData({ abi: gen8BidHookAbi, functionName: "preview", args: [auction, owner, witnesses] });
    const raw = await rpc.call({ to: hook, data, blockNumber });
    check(raw.data, "WALLET_STATE_UNAVAILABLE", "The bid hook preview returned no data");
    const [committed, ceiling, allowance] = decodeFunctionResult({ abi: gen8BidHookAbi, functionName: "preview", data: raw.data });
    return { committed, ceiling, allowance };
  }
  async function walletAt(dealId: Hex, auction: Address, hook: Address, owner: Address, at: Anchor): Promise<WalletRead> {
    check(terms, "AUCTION_BINDINGS_REQUIRED", "A terms registry pin is required");
    const blockNumber = at.blockNumber;
    const [state, balance, termsAccepted] = await Promise.all([
      walletBids(auction, hook, owner, blockNumber),
      rpc.readContract({ address: quote, abi: tokenAbi, functionName: "balanceOf", args: [owner], blockNumber }),
      rpc.readContract({ address: terms, abi: termsRegistryAbi, functionName: "hasAccepted", args: [owner], blockNumber }),
    ]);
    const limits = await previewLimits(auction, hook, owner, state.witnesses, blockNumber);
    const { positions, clearingPrice, minimumRaiseMet, creatorExcluded } = state;
    const maximumBid = maximumNewBid({ allowance: limits.allowance, balance });
    return { witnesses: state.witnesses, limits: Object.freeze({ ...at, dealId, auction, owner, clearingPriceQ96: clearingPrice, minimumRaiseMet,
      creatorExcluded, termsAccepted, minimumBid: BigInt(GEN8_BID_RULES.minBid), ...limits, balance, maximumBid,
      liveBids: liveBids(positions), bidsLeft: creatorExcluded ? 0 : bidsRemaining(positions), positions: Object.freeze(positions), rules: GEN8_BID_RULES }) };
  }
  /** Wallet limits for a Gen8 auction, read at one block: the same numbers the hook enforces, for forms and pre-checks. */
  async function getDynamicBidLimits(input: { dealId: Hex; owner: Address }): Promise<DynamicBidLimits> {
    check(context.gen8, "GEN8_REQUIRED", "Dynamic Bid limits exist only on Gen8 deployments");
    hash(input.dealId); address(input.owner);
    const at = await anchor(), { hook, auction } = await auctions.resolveAt(input.dealId, at);
    const { limits } = await walletAt(input.dealId, auction.auction, hook, input.owner, at);
    await canonical(at);
    return limits;
  }
  return { walletAt, getDynamicBidLimits };
}
export type DynamicWallet = ReturnType<typeof createDynamicWallet>;
