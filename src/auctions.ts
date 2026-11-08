import type { Address, Hex } from "viem";
import { ccaAuctionAbi } from "./auction-abis.js";
import { buildAuctionClaim, buildAuctionRefund, type PartialFillHints } from "./auction-transactions.js";
import { parseDeployment } from "./deployment.js";
import { address, check, uint } from "./validation.js";
import { createAuctionContext } from "./auction-context.js";
import { createAuctionReader } from "./auction-state.js";
import { createDynamicWallet } from "./auction-wallet.js";
import { createDynamicBidPreparer } from "./auction-bid.js";
import type { RpcClient, Transaction } from "./types.js";
export { buildAuctionBidApprovals, buildAuctionClaim, buildAuctionRefund } from "./auction-transactions.js";
export type { PartialFillHints } from "./auction-transactions.js";
export * from "./auction-abis.js";
export { buildDynamicBid, buildDynamicRebid, encodeBidWitnesses, decodeBidWitnesses, type BidWitness, type DynamicBidInput } from "./bid-transactions.js";
export { MIN_BID, TOKEN_CAP, MAX_LIVE_BIDS, MAX_WALLET_BIDS, MAX_PRICE_LEVELS, BID_RULES, ACCEPTED_BID_FEE_BPS,
  acceptedBidFee, bidDebit, affordableBid, walletCeiling, walletAllowance, liveBids, bidsRemaining, maximumNewBid, bidRefusal, alignBidPrice,
  type BidPosition, type BidRefusal, type WalletLimits } from "./bid-rules.js";
export { MAX_FLOOR_PRICE_WAD, MINIMUM_NET_RAISE, MINIMUM_GROSS_RAISE } from "./controller-rules.js";
export { witnessFor, normalizeCheckpoints, type Checkpoint, type WitnessBid } from "./witnesses.js";
export type { DynamicBidLimits } from "./auction-wallet.js";
export type { DynamicBidRequest, DynamicRebidRequest } from "./auction-bid.js";
export { decodeOxleyRevert, type OxleyRevert, type OxleyRevertName } from "./revert.js";

/**
 * Unsigned auction transactions for one reviewed deployment: wallet limits, Dynamic Bids and rebids, exits (refunds) and token claims.
 * Every preparation verifies the deployment at one block, simulates where it can and never signs or sends.
 */
export function createOxleyAuctionClient(options: { publicClient: RpcClient; deployment: unknown }) {
  const rpc = options.publicClient, deployment = parseDeployment(options.deployment);
  const context = createAuctionContext(rpc, deployment);
  const { anchor, canonical, verifyAt } = context;
  const auctions = createAuctionReader(context);
  const { auctionAt, getAuction } = auctions;
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
  return { deployment, verifyDeployment, getAuction, getDynamicBidLimits, prepareDynamicBid, prepareDynamicRebid,
    prepareClaim: (input: { dealId: Hex; bidId: bigint; caller: Address }) => recovery(input, true),
    prepareRefund: (input: { dealId: Hex; bidId: bigint; caller: Address; partialFill?: PartialFillHints }) => recovery(input, false),
  };
}
export type OxleyAuctionClient = ReturnType<typeof createOxleyAuctionClient>;
