import { formatUnits, type Address, type Hex } from "viem";
import { auctionAdapterAbi, auctionBidRouterAbi, ccaAuctionAbi } from "./auction-abis.js";
import { buildAuctionBidApprovals } from "./auction-transactions.js";
import { tokenAbi } from "./abis.js";
import { gen8AdapterAbi, ccaCheckpointAbi } from "./gen8-abis.js";
import { acceptedBidFee, bidRefusal, GEN8_MIN_BID, type Gen8Refusal } from "./gen8-bid-rules.js";
import { buildDynamicBid, buildDynamicRebid, type BidWitness } from "./gen8-bid-transactions.js";
import { address, check, hash, OxleyError, uint } from "./validation.js";
import type { RpcClient, Transaction } from "./types.js";
import type { AuctionContext } from "./auction-context.js";
import type { AuctionReader } from "./auction-state.js";
import type { DynamicBidLimits, DynamicWallet } from "./auction-gen8-wallet.js";

export interface DynamicBidRequest {
  dealId: Hex; caller: Address;
  /** Principal in Oxy-USDC base units (at least 20); the 0.1% accepted-bid fee is charged on top. */
  entered: bigint;
  /** Native CCA Q96 price: on the auction's tick and above its clearing price. */
  maxPriceQ96: bigint;
  /** Omit to derive it from the auction's initialized ticks. */
  previousTick?: bigint;
  /** Unix seconds. Omit for two minutes from the later of the head block and the local clock. */
  deadline?: bigint;
  /** Simulates the router call from `caller` (needs balance and approvals first). */
  simulate?: boolean;
}
export interface DynamicRebidRequest extends DynamicBidRequest { oldBidId: bigint }

const REFUSALS: Record<Gen8Refusal, [string, string]> = {
  creator: ["CREATOR_BID_NOT_ALLOWED", "Creators can't bid on their own auction"],
  terms: ["TERMS_NOT_ACCEPTED", "The wallet must accept the current terms before bidding"],
  bids: ["WALLET_BID_LIMIT", "This wallet has no free bid slot: at most 3 live bids and 12 bids in total per auction"],
  minimum: ["BID_TOO_LOW", "Minimum bid is 20 Oxy-USDC"],
  cap: ["WALLET_CAP_EXCEEDED", "This bid is above the wallet's limit on this auction"],
};
function refuse(refusal: Gen8Refusal, limits: DynamicBidLimits, principal: bigint, symbol: string): never {
  const [code, message] = REFUSALS[refusal];
  const detail = refusal === "cap" && limits.maximumBid > 0n ? `You can bid up to ${formatUnits(limits.maximumBid, 6)} ${symbol} here` : message;
  throw new OxleyError(code, detail, { owner: limits.owner, principal, maximumBid: limits.maximumBid, bidsLeft: limits.bidsLeft });
}
/** Where to insert a new price level: the last initialized tick below it (any tick works when the level already exists). */
async function previousTickFor(rpc: RpcClient, auction: Address, floor: bigint, price: bigint, blockNumber: bigint): Promise<bigint> {
  const at = { address: auction, abi: ccaCheckpointAbi, blockNumber } as const;
  if ((await rpc.readContract({ ...at, functionName: "ticks", args: [price] })).next !== 0n) return floor;
  const active = await rpc.readContract({ ...at, functionName: "nextActiveTickPrice" });
  let previous = active < price ? active : floor;
  for (let steps = 0; steps <= 1000; steps++) {
    const { next } = await rpc.readContract({ ...at, functionName: "ticks", args: [previous] });
    check(next > previous, "TICK_UNAVAILABLE", "The auction's tick list is inconsistent");
    if (next >= price) return previous;
    previous = next;
  }
  throw new OxleyError("TICK_UNAVAILABLE", "Too many price levels to locate the previous tick");
}

type Reads = Awaited<ReturnType<ReturnType<typeof createAuctionReads>>>;
/** The chain facts a bid is checked against, all read at one block. */
function createAuctionReads(context: AuctionContext) {
  const { rpc, deployment, bidRouter, adapter } = context;
  return async function readAuction(auction: Address, caller: Address, entered: bigint, blockNumber: bigint) {
    const cca = { address: auction, abi: ccaAuctionAbi, blockNumber } as const;
    const [quoted, start, end, current, floor, spacing, maximum, allowance] = await Promise.all([
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "quoteBid", args: [entered], blockNumber }),
      rpc.readContract({ ...cca, functionName: "startBlock" }), rpc.readContract({ ...cca, functionName: "endBlock" }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "currentBlock", blockNumber }),
      rpc.readContract({ ...cca, functionName: "floorPrice" }), rpc.readContract({ ...cca, functionName: "tickSpacing" }),
      rpc.readContract({ address: adapter.address, abi: gen8AdapterAbi, functionName: "MAX_CCA_BID_PRICE_Q96", blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "allowance", args: [caller, bidRouter.address], blockNumber }),
    ]);
    return { principal: quoted[0], debit: quoted[1], fee: quoted[2], start, end, current, floor, spacing, maximum, allowance };
  };
}
/** Fails closed on everything the router, hook or CCA would refuse that can be known before simulation. */
function validateBid(input: DynamicBidRequest, open: boolean, reads: Reads, limits: DynamicBidLimits, rebid: boolean, symbol: string): void {
  check(open && reads.current >= reads.start && reads.current < reads.end, "AUCTION_NOT_OPEN", "Auction is not accepting bids");
  check(reads.principal === input.entered && reads.fee === acceptedBidFee(input.entered) && reads.debit === reads.principal + reads.fee,
    "INVALID_BID_QUOTE", "Inconsistent router quote");
  check(reads.spacing > 0n && input.maxPriceQ96 % reads.spacing === 0n && input.maxPriceQ96 > limits.clearingPriceQ96
    && input.maxPriceQ96 <= reads.maximum, "INVALID_BID_PRICE", "Bid price must be on tick, above the clearing price and within the CCA ceiling");
  const refusal = bidRefusal(limits, reads.principal, rebid);
  if (refusal) refuse(refusal, limits, reads.principal, symbol);
}

export function createDynamicBidPreparer(context: AuctionContext, auctions: AuctionReader, wallet: DynamicWallet) {
  const { rpc, deployment, bidRouter, anchor, canonical } = context;
  const readAuction = createAuctionReads(context);
  async function simulateBid(input: DynamicBidRequest, ready: { transaction: Transaction; approvals: readonly unknown[];
    balance: bigint; debit: bigint; blockNumber: bigint }) {
    if (!input.simulate) return;
    check(ready.balance >= ready.debit, "INSUFFICIENT_BALANCE", "Caller needs principal plus the quoted fee");
    check(ready.approvals.length === 0, "APPROVAL_REQUIRED", "Confirm approvals before simulating the bid");
    await rpc.call({ ...ready.transaction, account: input.caller, blockNumber: ready.blockNumber });
  }
  async function prepare(input: DynamicBidRequest, rebidOf?: bigint) {
    check(context.gen8, "GEN8_REQUIRED", "Dynamic Bids exist only on Gen8 deployments");
    hash(input.dealId); address(input.caller); uint(input.entered); uint(input.maxPriceQ96);
    check(input.entered >= GEN8_MIN_BID, "BID_TOO_LOW", REFUSALS.minimum[1]);
    const at = await anchor(), { hook, auction } = await auctions.resolveAt(input.dealId, at), blockNumber = at.blockNumber;
    const deadline = input.deadline ?? defaultDeadline(at);
    check(deadline > at.timestamp, "EXPIRED_DEADLINE", "Supply a future Unix deadline");
    const [reads, state] = await Promise.all([readAuction(auction.auction, input.caller, input.entered, blockNumber),
      wallet.walletAt(input.dealId, auction.auction, hook, input.caller, at)]);
    validateBid(input, auction.open, reads, state.limits, rebidOf !== undefined, deployment.quoteToken.symbol);
    const exit = rebidOf === undefined ? undefined : rebidExit(state.limits, state.witnesses, rebidOf);
    const previousTick = input.previousTick ?? await previousTickFor(rpc, auction.auction, reads.floor, input.maxPriceQ96, blockNumber);
    const common = { dealId: input.dealId, maxPriceQ96: input.maxPriceQ96, entered: input.entered, previousTick, deadline,
      witnesses: state.witnesses, chainId: deployment.chainId, bidRouter: bidRouter.address };
    const transaction = exit && rebidOf !== undefined ? buildDynamicRebid({ ...common, oldBidId: rebidOf, exit }) : buildDynamicBid(common);
    const approvals = buildAuctionBidApprovals({ chainId: deployment.chainId, quoteToken: deployment.quoteToken.address,
      bidRouter: bidRouter.address, debit: reads.debit, currentAllowance: reads.allowance });
    await simulateBid(input, { transaction, approvals, balance: state.limits.balance, debit: reads.debit, blockNumber });
    await canonical(at);
    return { ...at, ...auction, kind: rebidOf === undefined ? "bid" as const : "rebid" as const, transaction, principal: reads.principal,
      debit: reads.debit, fee: reads.fee, approvals, balance: state.limits.balance, allowance: reads.allowance,
      sufficientBalance: state.limits.balance >= reads.debit, owner: input.caller, simulated: input.simulate === true, deadline, previousTick,
      limits: state.limits, witnesses: state.witnesses, ...(exit && rebidOf !== undefined ? { oldBidId: rebidOf, exit } : {}) };
  }
  return { prepareDynamicBid: (input: DynamicBidRequest) => prepare(input),
    prepareDynamicRebid: async (input: DynamicRebidRequest) => { uint(input.oldBidId, false); return prepare(input, input.oldBidId); } };
}
/**
 * Elysium (Orbit) mines no empty blocks, so the head can be hours old on a quiet chain: a deadline counted from the head alone
 * would be expired when the wallet is asked to sign. Count two minutes from the later of the head and the local clock.
 */
const defaultDeadline = (head: { timestamp: bigint }) => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return (head.timestamp > now ? head.timestamp : now) + 120n;
};
/** The outbid, unexited bid whose exit the router performs first. The CCA refuses a partial exit before the minimum raise is met. */
function rebidExit(limits: DynamicBidLimits, witnesses: readonly BidWitness[], oldBidId: bigint): BidWitness {
  const index = limits.positions.findIndex(position => position.bidId === oldBidId), position = limits.positions[index];
  if (!position || !position.outbid || position.exited || !limits.minimumRaiseMet) {
    throw new OxleyError("REBID_NOT_AVAILABLE", "Only an outbid, unexited bid can be rebid, and only once the auction has met its minimum raise", { oldBidId });
  }
  return witnesses[index]!;
}
