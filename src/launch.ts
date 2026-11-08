import { parseDeployment } from "./deployment.js";
import { createLaunchContext } from "./launch-context.js";
import { createLaunchReader } from "./launch-account.js";
import { createLaunchPreparer } from "./launch-preparation.js";
import type { LaunchRpcClient } from "./launch-types.js";
export type { AuctionLaunchInput, LaunchRpcClient, LaunchStage, LaunchTransaction } from "./launch-types.js";
export type { LaunchIdentity, LaunchState } from "./launch-account.js";
export { auctionDurationBounds, auctionDurationBlocks, sampleSecondsPerBlock, AUCTION_MIN_BLOCKS_PER_HOUR, AUCTION_MAX_BLOCKS_PER_HOUR, BLOCK_RATE_SAMPLE_BLOCKS } from "./launch-duration.js";
export { launchDealId, newDraftSalt, validateAuctionLaunch } from "./launch-input.js";
export { buildCreatorAccount, buildLaunchApprovals, buildAuctionLaunch } from "./launch-transactions.js";
export { buildAcceptTerms } from "./client-terms.js";
export { quoteAuctionFloor, floorReachesMinimumRaise, minimumRaiseFloor, validateLaunchFloor, OFFERED_UNITS } from "./launch-floor.js";
export { MAX_FLOOR_PRICE_WAD, MINIMUM_NET_RAISE, MINIMUM_GROSS_RAISE } from "./controller-rules.js";
export { launchFloorAbi, launchFloorCapAbi, launchMinimumRaiseAbi } from "./auction-abis.js";
export { creatorAccountAbi, creatorAccountFactoryAbi, launchBondAbi, launchControllerAbi, launchEntryAbi } from "./launch-abis.js";
export { decodeOxleyRevert, type OxleyRevert, type OxleyRevertName } from "./revert.js";

/**
 * Unsigned launch transactions for one reviewed deployment, one verified and simulated step at a time: accept the terms, create the creator account,
 * approve the launch fee to it, launch (which carries the native operating bond), then read the launch back. Every preparation verifies the whole launch
 * graph at one block first, applies the launch-floor rules, simulates from the creator and never signs or sends.
 */
export function createOxleyLaunchClient(options: { publicClient: LaunchRpcClient; deployment: unknown }) {
  const deployment = parseDeployment(options.deployment);
  const context = createLaunchContext(options.publicClient, deployment);
  const reader = createLaunchReader(context);
  const prepareLaunch = createLaunchPreparer(context, reader);
  return { deployment, verifyDeployment: context.verifyDeployment, getLaunch: reader.getLaunch, prepareLaunch };
}
export type OxleyLaunchClient = ReturnType<typeof createOxleyLaunchClient>;
