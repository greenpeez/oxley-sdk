import type { Address, Hex } from "viem";
import { ccaAuctionAbi } from "./auction-abis.js";
import { buildAuctionClaim, buildAuctionRefund, type PartialFillHints } from "./auction-transactions.js";
import { address, check, hash, parseDeployment, uint } from "./validation.js";
import { createAuctionContext } from "./auction-context.js";
import { createAuctionReader } from "./auction-state.js";
import { createBidAllowanceReader } from "./auction-breadth.js";
import { createBidPreparer } from "./auction-bid.js";
import type { ContractPin, Deployment, RpcClient, Transaction } from "./types.js";
export { buildAuctionBid, buildAuctionBidApprovals, buildAuctionClaim, buildAuctionRefund } from "./auction-transactions.js";
export type { AuctionBidInput, PartialFillHints } from "./auction-transactions.js";
export * from "./auction-abis.js";
export * from "./gen2-abis.js";
export { decodeOxleyRevert, type OxleyRevert, type OxleyRevertName } from "./revert.js";

export interface AuctionDeployment extends Deployment {
  auctionBindings: { controllerRuntimeCodeHash: Hex; bidRouter: ContractPin; adapter: ContractPin };
}
export function parseAuctionDeployment(input: unknown): AuctionDeployment {
  const deployment = parseDeployment(input);
  const pins = (input as AuctionDeployment).auctionBindings;
  check(pins && typeof pins === "object", "AUCTION_BINDINGS_REQUIRED", "Reviewed auction runtime pins are required");
  hash(pins.controllerRuntimeCodeHash);
  for (const pin of [pins.bidRouter, pins.adapter]) {
    check(pin && typeof pin === "object", "AUCTION_BINDINGS_REQUIRED", "Router and adapter pins required");
    address(pin.address); hash(pin.runtimeCodeHash);
  }
  check(new Set([deployment.auctionController, pins.bidRouter.address, pins.adapter.address,
    deployment.quoteToken.address, deployment.registry.address].map(a => a.toLowerCase())).size === 5,
  "INVALID_DEPLOYMENT", "Auction contracts and quote token must be distinct");
  return Object.freeze({ ...deployment, auctionBindings: Object.freeze({ ...pins,
    bidRouter: Object.freeze({ ...pins.bidRouter }), adapter: Object.freeze({ ...pins.adapter }) }) });
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
  return { deployment, verifyDeployment, getAuction, getBidAllowance, prepareBid,
    prepareClaim: (input: { dealId: Hex; bidId: bigint; caller: Address }) => recovery(input, true),
    prepareRefund: (input: { dealId: Hex; bidId: bigint; caller: Address; partialFill?: PartialFillHints }) => recovery(input, false),
  };
}
