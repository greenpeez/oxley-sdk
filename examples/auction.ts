import type { Address, Hex, PublicClient } from "viem";
import { createOxleyAuctionClient, type AuctionBidInput, type PartialFillHints } from "@oxley/sdk/auctions";

/** The host wallet retains signing, submission and receipt/reorg handling. */
export function auctionIntegration(publicClient: PublicClient, deployment: unknown) {
  const auctions = createOxleyAuctionClient({ publicClient, deployment });
  return {
    // Show principal/fee/debit and confirm approvals before requesting the simulated bid.
    previewBid: (input: AuctionBidInput, caller: Address) => auctions.prepareBid({ ...input, caller }),
    readyBid: (input: AuctionBidInput, caller: Address) => auctions.prepareBid({ ...input, caller, simulate: true }),
    refund: (dealId: Hex, bidId: bigint, caller: Address, partialFill?: PartialFillHints) =>
      auctions.prepareRefund({ dealId, bidId, caller, partialFill }),
    // Call after a successful exit receipt, not immediately after constructing the exit.
    claim: (dealId: Hex, bidId: bigint, caller: Address) => auctions.prepareClaim({ dealId, bidId, caller }),
  };
}
