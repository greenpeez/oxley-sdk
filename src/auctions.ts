import type { Address, Hex } from "viem";
import { ccaAuctionAbi } from "./auction-abis.js";
import { buildAuctionClaim, buildAuctionRefund, type PartialFillHints } from "./auction-transactions.js";
import { address, check, deploymentGeneration, hash, parseDeployment, uint } from "./validation.js";
import { GEN8_BID_RULES } from "./gen8-bid-rules.js";
import { createAuctionContext } from "./auction-context.js";
import { createAuctionReader } from "./auction-state.js";
import { createBidAllowanceReader } from "./auction-breadth.js";
import { createBidPreparer } from "./auction-bid.js";
import { createDynamicWallet } from "./auction-gen8-wallet.js";
import { createDynamicBidPreparer } from "./auction-gen8-bid.js";
import type { ContractPin, Deployment, RpcClient, Transaction } from "./types.js";
export { buildAuctionBid, buildAuctionBidApprovals, buildAuctionClaim, buildAuctionRefund } from "./auction-transactions.js";
export type { AuctionBidInput, PartialFillHints } from "./auction-transactions.js";
export * from "./auction-abis.js";
export * from "./gen2-abis.js";
export * from "./gen3-abis.js";
export * from "./gen8-abis.js";
export { buildDynamicBid, buildDynamicRebid, encodeBidWitnesses, decodeBidWitnesses, type BidWitness, type DynamicBidInput } from "./gen8-bid-transactions.js";
export { GEN8_MIN_BID, GEN8_TOKEN_CAP, GEN8_MAX_LIVE_BIDS, GEN8_MAX_WALLET_BIDS, GEN8_MAX_PRICE_LEVELS, GEN8_BID_RULES, ACCEPTED_BID_FEE_BPS,
  acceptedBidFee, bidDebit, affordableBid, walletCeiling, walletAllowance, liveBids, bidsRemaining, maximumNewBid, bidRefusal, alignBidPrice,
  type Gen8Position, type Gen8Refusal, type Gen8WalletLimits } from "./gen8-bid-rules.js";
export { witnessFor, normalizeCheckpoints, type Checkpoint, type WitnessBid } from "./gen8-witnesses.js";
export type { DynamicBidLimits } from "./auction-gen8-wallet.js";
export type { DynamicBidRequest, DynamicRebidRequest } from "./auction-gen8-bid.js";
export { decodeOxleyRevert, type OxleyRevert, type OxleyRevertName } from "./revert.js";

export interface AuctionDeployment extends Deployment {
  auctionBindings: { controllerRuntimeCodeHash: Hex; bidRouter: ContractPin; adapter: ContractPin;
    /** Gen8 only: the Dynamic Bids hook and its exposure helper. */
    bidHook?: ContractPin; exposureHelper?: ContractPin };
  /** Gen8 only: the exact compiled bid rules; any other value is refused. */
  bidRules?: typeof GEN8_BID_RULES;
}
function gen8Bindings(deployment: Deployment, pins: AuctionDeployment["auctionBindings"], rules: unknown): ContractPin[] {
  if (deploymentGeneration(deployment) !== "gen8") {
    check(!pins.bidHook && !pins.exposureHelper && rules === undefined, "INVALID_DEPLOYMENT", "Bid hook, exposure helper and bid rules belong to Gen8");
    return [];
  }
  check(pins.bidHook && pins.exposureHelper, "AUCTION_BINDINGS_REQUIRED", "Gen8 needs the bid hook and exposure helper pins");
  check(!!rules && typeof rules === "object" && Object.keys(rules).length === Object.keys(GEN8_BID_RULES).length
    && Object.entries(GEN8_BID_RULES).every(([key, value]) => (rules as Record<string, unknown>)[key] === value),
  "INVALID_BID_RULES", "The manifest's bid rules must be exactly the compiled Gen8 rules");
  for (const pin of [pins.bidHook, pins.exposureHelper]) { address(pin.address); hash(pin.runtimeCodeHash); }
  return [pins.bidHook, pins.exposureHelper];
}
export function parseAuctionDeployment(input: unknown): AuctionDeployment {
  const deployment = parseDeployment(input);
  // Gen3 bids are not supported: its router and hook take other arguments, and no Gen3 auction accepts new bids.
  check(deploymentGeneration(deployment) !== "gen3", "UNSUPPORTED_GENERATION", "The auctions client supports flat-fee, Gen2 and Gen8 deployments");
  const { auctionBindings: pins, bidRules } = input as AuctionDeployment;
  check(pins && typeof pins === "object", "AUCTION_BINDINGS_REQUIRED", "Reviewed auction runtime pins are required");
  hash(pins.controllerRuntimeCodeHash);
  for (const pin of [pins.bidRouter, pins.adapter]) {
    check(pin && typeof pin === "object", "AUCTION_BINDINGS_REQUIRED", "Router and adapter pins required");
    address(pin.address); hash(pin.runtimeCodeHash);
  }
  const extra = gen8Bindings(deployment, pins, bidRules);
  const addresses = [deployment.auctionController, pins.bidRouter.address, pins.adapter.address, deployment.quoteToken.address,
    deployment.registry.address, ...extra.map(pin => pin.address), ...deployment.termsRegistry ? [deployment.termsRegistry.address] : []];
  check(new Set(addresses.map(a => a.toLowerCase())).size === addresses.length, "INVALID_DEPLOYMENT", "Auction contracts and quote token must be distinct");
  return Object.freeze({ ...deployment, auctionBindings: Object.freeze({ ...pins,
    bidRouter: Object.freeze({ ...pins.bidRouter }), adapter: Object.freeze({ ...pins.adapter }),
    ...(extra.length ? { bidHook: Object.freeze({ ...extra[0]! }), exposureHelper: Object.freeze({ ...extra[1]! }) } : {}) }),
  ...(bidRules ? { bidRules: Object.freeze({ ...bidRules }) } : {}) });
}
export function createOxleyAuctionClient(options: { publicClient: RpcClient; deployment: unknown }) {
  const rpc = options.publicClient, deployment = parseAuctionDeployment(options.deployment);
  const context = createAuctionContext(rpc, deployment);
  const { anchor, canonical, verifyAt } = context;
  const auctions = createAuctionReader(context);
  const { auctionAt, getAuction } = auctions;
  const allowances = createBidAllowanceReader(context, auctions);
  const { getBidAllowance } = allowances;
  const prepareBid = createBidPreparer(context, auctions, allowances);
  const wallet = createDynamicWallet(context, auctions);
  const { getDynamicBidLimits } = wallet;
  const { prepareDynamicBid, prepareDynamicRebid } = createDynamicBidPreparer(context, auctions, wallet);
  async function verifyDeployment() {
    const at = await anchor(); await verifyAt(at); await canonical(at);
    return { deployment, ...at };
  }
  async function recovery(input: { dealId: Hex; bidId: bigint; caller: Address; partialFill?: PartialFillHints }, claim: boolean) {
    uint(input.bidId, false); address(input.caller);
    const at = await anchor(), auction = await auctionAt(input.dealId, at);
    const bid = await rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "bids",
      args: [input.bidId], blockNumber: at.blockNumber });
    address(bid.owner);
    check(claim ? bid.exitedBlock > 0n && bid.tokensFilled > 0n : bid.exitedBlock === 0n,
      claim ? "NOT_CLAIMABLE" : "ALREADY_EXITED", claim ? "Exit first; no unclaimed token allocation is available" : "Bid already exited");
    const args = { chainId: deployment.chainId, auction: auction.auction, bidId: input.bidId };
    const transaction: Transaction = claim ? buildAuctionClaim(args) : buildAuctionRefund({ ...args, partialFill: input.partialFill });
    // Simulation enforces the auction outcome, timing and exact partial-fill hints without writing chain state.
    await rpc.call({ ...transaction, account: input.caller, blockNumber: at.blockNumber });
    await canonical(at);
    return { ...at, ...auction, transaction, bidId: input.bidId, owner: bid.owner, simulated: true as const };
  }
  return { deployment, verifyDeployment, getAuction, getBidAllowance, prepareBid, getDynamicBidLimits, prepareDynamicBid, prepareDynamicRebid,
    prepareClaim: (input: { dealId: Hex; bidId: bigint; caller: Address }) => recovery(input, true),
    prepareRefund: (input: { dealId: Hex; bidId: bigint; caller: Address; partialFill?: PartialFillHints }) => recovery(input, false),
  };
}
