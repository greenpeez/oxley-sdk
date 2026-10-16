import { createPublicClient, http, parseUnits, type Address, type Hex } from "viem";
import { createOxleyLaunchClient, type AuctionLaunchInput } from "@oxley/sdk/launch";

/** Your application must persist and reconcile this identity and its submitted hashes. */
export function launchIntent(owner: Address, persistedDealId: Hex): AuctionLaunchInput {
  return { owner, dealId: persistedDealId, name: "Example Coin", symbol: "EXAMPLE",
    floorPriceWad: parseUnits("0.00001", 24), creatorLockDays: 30,
    listingCommitmentBps: 5000, auctionDurationHours: 1 };
}

export async function prepareNextLaunchStep(rpcUrl: string, reviewedDeployment: unknown, persistedIntent: AuctionLaunchInput) {
  const launches = createOxleyLaunchClient({ deployment: reviewedDeployment,
    publicClient: createPublicClient({ transport: http(rpcUrl) }) });
  const step = await launches.prepareLaunch(persistedIntent);
  if (step.stage === "complete") return step;
  if (BigInt(Math.floor(Date.now() / 1000)) >= step.expiresAt) throw new Error("Preparation expired; prepare again");
  // Display terms/costs and verify the signing wallet's owner and chain.
  // Journal the pending intent before submitting step.transaction; retain the hash
  // and wait for a successful canonical receipt before calling this function again.
  // An uncertain submission must be reconciled, not automatically resubmitted.
  return step;
}
