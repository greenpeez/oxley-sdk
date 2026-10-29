import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyAuctionClient } from "@oxley/sdk/auctions";

// A Gen8 Dynamic Bid: read the wallet's limits, then prepare the bid with its witnesses.
export async function bid(deployment: unknown, rpcUrl: string, dealId: Hex, owner: Address, maxPriceQ96: bigint) {
  const auctions = createOxleyAuctionClient({ deployment, publicClient: createPublicClient({ transport: http(rpcUrl) }) });
  const limits = await auctions.getDynamicBidLimits({ dealId, owner });
  if (limits.maximumBid < 20_000_000n) throw new Error("This wallet cannot bid on this auction right now");
  const prepared = await auctions.prepareDynamicBid({ dealId, caller: owner, entered: limits.maximumBid < 100_000_000n ? limits.maximumBid : 100_000_000n, maxPriceQ96 });
  // Send prepared.approvals in order, wait for receipts, then prepare again with simulate: true
  // and send prepared.transaction from `owner`.
  return prepared;
}
