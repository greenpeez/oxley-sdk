import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyAuctionClient } from "@oxley/sdk/auctions";

// A Dynamic Bid: read the wallet's limits, then prepare the bid with its witnesses.
export async function bid(deployment: unknown, rpcUrl: string, dealId: Hex, owner: Address, maxPriceQ96: bigint) {
  const auctions = createOxleyAuctionClient({ deployment, publicClient: createPublicClient({ transport: http(rpcUrl) }) });
  const limits = await auctions.getDynamicBidLimits({ dealId, owner });
  if (limits.maximumBid < limits.minimumBid) throw new Error("This wallet cannot bid on this auction right now");
  const entered = limits.maximumBid < 100_000_000n ? limits.maximumBid : 100_000_000n;
  const prepared = await auctions.prepareDynamicBid({ dealId, caller: owner, entered, maxPriceQ96 });
  // Send prepared.approvals in order, wait for receipts, then prepare again with simulate: true
  // and send prepared.transaction from `owner`.
  return prepared;
}

// A rebid exits one outbid bid and bids again in one transaction, once the auction has met its minimum raise.
export async function rebid(deployment: unknown, rpcUrl: string, dealId: Hex, owner: Address, oldBidId: bigint, maxPriceQ96: bigint, entered: bigint) {
  const auctions = createOxleyAuctionClient({ deployment, publicClient: createPublicClient({ transport: http(rpcUrl) }) });
  return auctions.prepareDynamicRebid({ dealId, caller: owner, oldBidId, entered, maxPriceQ96, simulate: true });
}
