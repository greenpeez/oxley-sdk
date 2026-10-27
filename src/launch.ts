import { createLaunchContext } from "./launch-context.js";
import { createLaunchReader } from "./launch-account.js";
import { createLaunchPreparer } from "./launch-preparation.js";
import { parseLaunchDeployment } from "./launch-deployment.js";
import type { LaunchRpcClient } from "./launch-types.js";
export type { LaunchRpcClient, LaunchDeployment, AuctionLaunchInput, AuctionLaunchTransaction } from "./launch-types.js";
export { auctionDurationBounds, auctionDurationBlocks, sampleSecondsPerBlock,
  AUCTION_MIN_BLOCKS_PER_HOUR, AUCTION_MAX_BLOCKS_PER_HOUR, BLOCK_RATE_SAMPLE_BLOCKS } from "./launch-duration.js";
export { quoteAuctionFloor, validateAuctionLaunch } from "./launch-input.js";
export { parseLaunchDeployment } from "./launch-deployment.js";
export { buildCreatorAccount, buildAuctionLaunch } from "./launch-transactions.js";
export * from "./launch-abis.js";
export * from "./gen2-abis.js";
export { decodeOxleyRevert, type OxleyRevert, type OxleyRevertName } from "./revert.js";

/** Unsigned, one-step preparation. Confirm each receipt, then call again with the same intent. */
export function createOxleyLaunchClient(options: { publicClient: LaunchRpcClient; deployment: unknown; maxBlockAgeSeconds?: number }) {
  const deployment = parseLaunchDeployment(options.deployment);
  const context = createLaunchContext(options.publicClient, deployment, options.maxBlockAgeSeconds ?? 120);
  const { verifyDeployment } = context;
  const launchReader = createLaunchReader(context);
  const { getLaunch } = launchReader;
  const prepareLaunch = createLaunchPreparer(context, launchReader);
  return { deployment, verifyDeployment, getLaunch, prepareLaunch };
}
