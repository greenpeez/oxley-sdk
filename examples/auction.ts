import type { Address, Hex, PublicClient } from "viem";
import { createOxleyAuctionClient, type PartialFillHints } from "@oxley/sdk/auctions";

/** The host wallet (or agent) retains signing, submission and receipt/reorg handling; every result here is unsigned and, where possible, simulated. */
export function auctionRecovery(publicClient: PublicClient, deployment: unknown) {
  const auctions = createOxleyAuctionClient({ publicClient, deployment });
  return {
    // Checks the deployment's pins, bindings, floor cap and minimum raise at one block before anything else is read.
    verify: () => auctions.verifyDeployment(),
    // Exit a bid: refunds a failed auction or the unfilled part of a bid. A partially filled bid needs explicit CCA checkpoint hints.
    refund: (dealId: Hex, bidId: bigint, caller: Address, partialFill?: PartialFillHints) =>
      auctions.prepareRefund({ dealId, bidId, caller, partialFill }),
    // Call after a successful exit receipt, not immediately after constructing the exit.
    claim: (dealId: Hex, bidId: bigint, caller: Address) => auctions.prepareClaim({ dealId, bidId, caller }),
  };
}
