import { parseLaunchDeployment } from "./deployment.js";
export { parseLaunchDeployment } from "./deployment.js";
import { createLaunchContext } from "./launch-context.js";
import { createLaunchReader } from "./launch-account.js";
import { createLaunchPreparer } from "./launch-preparation.js";
import { createScheduleActions } from "./launch-schedule.js";
import { createCreatorActions } from "./launch-creator.js";
import type { LaunchRpcClient } from "./launch-types.js";
export type { AuctionLaunchInput, CallerOption, CreatorClaim, LaunchRpcClient, LaunchStage, LaunchTransaction, ScheduleStage, ScheduledAction, ScheduledLaunchInput } from "./launch-types.js";
export type { CreatorAccountRef, CreatorRef, DealRef, LaunchIdentity, LaunchState } from "./launch-account.js";
export type { ScheduledLaunchInfo, ScheduledTerms } from "./launch-schedule.js";
export type { BondRefundReason, CreatorFeesReason } from "./launch-creator.js";
export { auctionDurationBounds, auctionDurationBlocks, sampleSecondsPerBlock, AUCTION_MIN_BLOCKS_PER_HOUR, AUCTION_MAX_BLOCKS_PER_HOUR, BLOCK_RATE_SAMPLE_BLOCKS } from "./launch-duration.js";
export { launchDealId, newDraftSalt, validateAuctionLaunch } from "./launch-input.js";
export { buildCreatorAccount, buildLaunchApprovals, buildAuctionLaunch } from "./launch-transactions.js";
export { buildScheduleAuctionLaunch, buildExecuteScheduledLaunch, buildRefundScheduledLaunch, buildClaimScheduledFee, buildClaimBondRefund, buildClaimCreatorFees } from "./creator-transactions.js";
export { validateScheduleStart, scheduleStartBounds, scheduledPhase, tickerKey, tickerCooldownEnd, SCHEDULE_MIN_LEAD_SECONDS, SCHEDULE_MAX_LEAD_SECONDS,
  SCHEDULE_EXECUTION_WINDOW_SECONDS, SCHEDULE_HOLD_COOLDOWN_SECONDS, SCHEDULED_EXECUTION_GAS_CAP, SCHEDULED_EXECUTION_MAX_GAS_PRICE, type ScheduledPhase } from "./schedule-rules.js";
export { buildAcceptTerms } from "./client-terms.js";
export { quoteAuctionFloor, floorReachesMinimumRaise, minimumRaiseFloor, validateLaunchFloor, OFFERED_UNITS } from "./launch-floor.js";
export { MAX_FLOOR_PRICE_WAD, MINIMUM_NET_RAISE, MINIMUM_GROSS_RAISE } from "./controller-rules.js";
export { launchFloorAbi, launchFloorCapAbi, launchMinimumRaiseAbi } from "./auction-abis.js";
export { creatorAccountAbi, creatorAccountFactoryAbi, creatorFeeRouterAbi, launchBondAbi, launchControllerAbi, launchEntryAbi } from "./launch-abis.js";
export { decodeOxleyRevert, type OxleyRevert, type OxleyRevertName } from "./revert.js";

/**
 * Unsigned launch transactions for one reviewed deployment, one verified and simulated step at a time: accept the terms, create the creator account,
 * approve the launch fee to it, launch (which carries the native operating bond), then read the launch back. Every preparation verifies the whole launch
 * graph at one block first, applies the launch-floor rules, simulates from the creator and never signs or sends.
 */
export function createOxleyLaunchClient(options: { publicClient: LaunchRpcClient; deployment: unknown;
  /** The clock in Unix seconds that start times and a schedule's phase are judged by when the chain is quiet. Defaults to the system clock; tests inject their own. */
  now?: () => number }) {
  const deployment = parseLaunchDeployment(options.deployment), clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const context = createLaunchContext(options.publicClient, deployment);
  const reader = createLaunchReader(context);
  const schedule = createScheduleActions(context, reader, clock), creator = createCreatorActions(context, reader, clock);
  const { prepareLaunch, prepareScheduledLaunch } = createLaunchPreparer(context, reader, schedule, clock);
  return { deployment, verifyDeployment: context.verifyDeployment, getLaunch: reader.getLaunch, prepareLaunch, prepareScheduledLaunch,
    getScheduledLaunch: schedule.getScheduledLaunch, prepareExecuteScheduledLaunch: schedule.prepareExecuteScheduledLaunch, prepareRefundScheduledLaunch: schedule.prepareRefundScheduledLaunch,
    prepareClaimScheduledFee: schedule.prepareClaimScheduledFee, getBondRefund: creator.getBondRefund, prepareBondRefundClaim: creator.prepareBondRefundClaim,
    getCreatorFees: creator.getCreatorFees, prepareCreatorFeeClaim: creator.prepareCreatorFeeClaim };
}
export type OxleyLaunchClient = ReturnType<typeof createOxleyLaunchClient>;
