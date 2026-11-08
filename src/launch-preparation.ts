import { zeroAddress } from "viem";
import { registryAbi, tokenAbi } from "./abis.js";
import { launchFloorAbi } from "./auction-abis.js";
import { buildAcceptTerms, readTermsStatus } from "./client-terms.js";
import { buildScheduleAuctionLaunch } from "./creator-transactions.js";
import { creatorAccountAbi, launchControllerAbi } from "./launch-abis.js";
import { auctionDurationBlocks, checkDurationBlocks, sampleSecondsPerBlock } from "./launch-duration.js";
import { quoteAuctionFloor } from "./launch-floor.js";
import { validateAuctionLaunch } from "./launch-input.js";
import { simulateStep } from "./launch-step.js";
import { buildAuctionLaunch, buildCreatorAccount, buildLaunchApprovals } from "./launch-transactions.js";
import { referenceTime, SCHEDULE_EXECUTION_WINDOW_SECONDS, SCHEDULE_HOLD_COOLDOWN_SECONDS, SCHEDULE_MAX_LEAD_SECONDS, SCHEDULE_MAX_NAME_BYTES, SCHEDULE_MAX_SIMULATED_GAS,
  SCHEDULE_MIN_LEAD_SECONDS, tickerCooldownEnd, tickerKey, validateScheduleStart } from "./schedule-rules.js";
import { check, OxleyError, sameAddress } from "./validation.js";
import type { Address } from "viem";
import type { Anchor } from "./types.js";
import type { LaunchContext } from "./launch-context.js";
import type { LaunchReader } from "./launch-account.js";
import type { ScheduleActions } from "./launch-schedule.js";
import type { AuctionLaunchInput, LaunchTransaction, ScheduledLaunchInput } from "./launch-types.js";

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

export function createLaunchPreparer(context: LaunchContext, reader: LaunchReader, schedule: ScheduleActions, clock: () => number) {
  const { rpc, deployment, factory, controller, verifyDeployment, canonical } = context;
  const quote = deployment.quoteToken, chainId = deployment.chainId;

  /** The exact CCA length: the caller's `durationBlocks`, else the hours at the caller's or the sampled block rate. */
  async function durationFor(input: AuctionLaunchInput, at: Anchor) {
    const hours = input.auctionDurationHours;
    if (input.durationBlocks !== undefined) return { durationBlocks: input.durationBlocks, secondsPerBlock: input.secondsPerBlock ?? null, rateSample: null };
    const sample = input.secondsPerBlock === undefined
      ? await sampleSecondsPerBlock(rpc, { notBefore: BigInt(deployment.startBlock), blockNumber: at.blockNumber }) : null;
    const secondsPerBlock = input.secondsPerBlock ?? sample!.secondsPerBlock;
    return { durationBlocks: auctionDurationBlocks({ hours, secondsPerBlock }), secondsPerBlock, rateSample: sample };
  }
  /**
   * What only a schedule needs beyond a launch: the ticker's hold (a hold that lapsed unused keeps the ticker out of scheduling for the controller's cooldown) and, once the
   * creator account exists, its scheduling constants, which must be the ones this SDK mirrors.
   */
  async function scheduleReads(symbol: string, account: Address | null, bondWei: bigint, blockNumber: bigint) {
    const onAccount = <N extends "SCHEDULED_BOND" | "MIN_LEAD" | "MAX_LEAD" | "EXECUTION_WINDOW" | "MAX_NAME_BYTES" | "MAX_SIMULATED_GAS">(functionName: N) =>
      rpc.readContract({ address: account!, abi: creatorAccountAbi, functionName, blockNumber });
    const [hold, cooldown, rules] = await Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "tickerHold", args: [tickerKey(symbol)], blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "HOLD_COOLDOWN", blockNumber }),
      account ? Promise.all([onAccount("SCHEDULED_BOND"), onAccount("MIN_LEAD"), onAccount("MAX_LEAD"), onAccount("EXECUTION_WINDOW"), onAccount("MAX_NAME_BYTES"), onAccount("MAX_SIMULATED_GAS")]) : null]);
    check(cooldown === BigInt(SCHEDULE_HOLD_COOLDOWN_SECONDS) && (rules === null || (rules[0] === bondWei && rules[1] === BigInt(SCHEDULE_MIN_LEAD_SECONDS) && rules[2] === BigInt(SCHEDULE_MAX_LEAD_SECONDS)
      && rules[3] === BigInt(SCHEDULE_EXECUTION_WINDOW_SECONDS) && rules[4] === SCHEDULE_MAX_NAME_BYTES && rules[5] === SCHEDULE_MAX_SIMULATED_GAS)),
    "SCHEDULE_RULES_MISMATCH", "The scheduled-launch rules on chain (bond, lead times, execution window, ticker cooldown) differ from this SDK; do not schedule against this release");
    return hold;
  }
  /**
   * Resolves the launch's state on chain and prepares its next step: accept the terms, create the creator account, approve the launch fee to it, then launch (or, with a
   * `startTime`, schedule it). Every step is simulated from the owner at the observation block. Confirm a step's receipt and prepare again with the same input: each call
   * re-reads the chain, so a confirmed step is never repeated, and a launched identity returns `stage: "complete"` with the launch read back. An account that has a schedule
   * pending is routed instead (`scheduled` before the start, `execute` in the 24 hour window, `refund` after it): see `getScheduledLaunch`.
   */
  async function prepare<L extends "launch" | "schedule">(input: AuctionLaunchInput, last: L, startTime?: number) {
    validateAuctionLaunch(input);
    // Only the shape of a start is checked before the chain is read: a pending schedule is routed whatever its start is now, and the bounds apply to a schedule yet to be made.
    if (startTime !== undefined) check(typeof startTime === "number" && Number.isSafeInteger(startTime) && startTime > 0, "INVALID_START_TIME", "startTime must be a whole number of Unix seconds");
    const { blockNumber, blockHash, timestamp, ...verified } = await verifyDeployment(), at: Anchor = { blockNumber, blockHash, timestamp };
    const state = await reader.stateAt(input, at);
    if (state.launched) { await canonical(at); return { ...at, ...state, stage: "complete" as const, transaction: null, owner: input.owner }; }
    // A pending schedule holds the account (and the ticker): it can be executed or refunded, never launched again or scheduled again.
    if (state.creatorAccount && state.scheduled) return schedule.routePending(input, at, verified, state);
    check(verified.publicLaunchEnabled && !verified.entriesPaused, "LAUNCH_PAUSED", "Public launches are disabled or paused");
    if (startTime !== undefined) validateScheduleStart(startTime, clock());
    const { owner } = input, beneficiary = input.beneficiary ?? owner, fee = verified.launchFee, bond = verified.deployerBondWei, localFloor = quoteAuctionFloor(input.floorPriceWad);
    const allowanceOf = state.creatorAccount ? rpc.readContract({ address: quote.address, abi: tokenAbi, functionName: "allowance", args: [owner, state.creatorAccount], blockNumber }) : 0n;
    const scheduling = startTime !== undefined;
    const [available, deal, floor, balance, nativeBalance, pending, confirmed, gasPrice, terms, allowance, hold] = await Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "isTickerAvailable", args: [input.symbol], blockNumber }),
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [state.dealId], blockNumber }),
      rpc.readContract({ address: deployment.auctionBindings.adapter.address, abi: launchFloorAbi, functionName: "effectiveFloor", args: [input.floorPriceWad], blockNumber }),
      rpc.readContract({ address: quote.address, abi: tokenAbi, functionName: "balanceOf", args: [owner], blockNumber }),
      rpc.getBalance({ address: owner, blockNumber }), rpc.getTransactionCount({ address: owner, blockTag: "pending" }),
      rpc.getTransactionCount({ address: owner, blockTag: "latest" }), rpc.getGasPrice(),
      readTermsStatus(rpc, deployment.termsRegistry.address, owner, at), allowanceOf,
      scheduling ? scheduleReads(input.symbol, state.creatorAccount, BigInt(bond), blockNumber) : undefined,
    ]);
    check(available, "TICKER_UNAVAILABLE", "The ticker is taken by an open auction or held for a scheduled launch");
    if (hold) {
      const from = tickerCooldownEnd(Number(hold[1]), referenceTime(at.timestamp, clock()).reference);
      if (from !== undefined) throw new OxleyError("TICKER_COOLDOWN", "This ticker was just held by a launch that did not start; it can be launched now, or scheduled from the time given", { scheduleFrom: from });
    }
    check(sameAddress(deal.creator, zeroAddress), "DEAL_ID_USED", "The deal id is already registered; do not create a new identity to retry");
    check(floor[0] === localFloor.floorPriceQ96 && floor[1] === localFloor.tickSpacingQ96, "FLOOR_MISMATCH", "The RPC's floor differs from this SDK's adapter calculation");
    check(balance >= fee, "INSUFFICIENT_QUOTE", `The creator needs the ${quote.symbol} launch fee`);
    check(nativeBalance >= bond, "INSUFFICIENT_BOND", "The creator needs the native operating bond plus gas");
    check(pending === confirmed, "PENDING_TRANSACTION", "Resolve the wallet's pending transaction before preparing again");
    check(gasPrice > 0n, "INVALID_GAS_PRICE", "The RPC must return a positive gas price");
    const needsTerms = !terms.accepted && terms.termsHash !== null;
    const approvalStages: ("reset" | "approve")[] = allowance >= fee && state.creatorAccount ? [] : allowance > 0n ? ["reset", "approve"] : ["approve"];
    const stages: ("terms" | "setup" | "reset" | "approve" | L)[] = [...needsTerms ? ["terms" as const] : [], ...state.creatorAccount ? [] : ["setup" as const], ...approvalStages, last];
    const stage = stages[0]!;
    let transaction: LaunchTransaction, duration: Awaited<ReturnType<typeof durationFor>> | null = null;
    if (stage === "terms") transaction = buildAcceptTerms({ chainId, termsRegistry: terms.termsRegistry, version: terms.requiredVersion, termsHash: terms.termsHash! });
    else if (stage === "setup") transaction = buildCreatorAccount({ chainId, factory, draftSalt: input.draftSalt, beneficiary });
    else if (stage === "reset" || stage === "approve") transaction = buildLaunchApprovals({ chainId, quoteToken: quote.address, creatorAccount: state.creatorAccount!, launchFee: fee, currentAllowance: allowance })[0]!;
    else {
      // The schedule's own dry run opens the auction, so the escrow's gas cap applies to scheduling as it does to launching.
      check(gasPrice <= verified.maxLaunchGasPrice, "GAS_PRICE_TOO_HIGH", "The gas price is above the cap the bond escrow accepts for a launch; wait for a lower gas price and prepare again");
      duration = await durationFor(input, at);
      checkDurationBlocks(input.auctionDurationHours, duration.durationBlocks);
      const terms = { chainId, creatorAccount: state.creatorAccount!, name: input.name, symbol: input.symbol, floorPriceWad: input.floorPriceWad,
        creatorLockDays: input.creatorLockDays, listingCommitmentBps: input.listingCommitmentBps, auctionDurationHours: input.auctionDurationHours,
        durationBlocks: duration.durationBlocks, bondWei: bond, gasPrice };
      transaction = scheduling ? buildScheduleAuctionLaunch({ ...terms, startTime: startTime!, now: clock() }) : buildAuctionLaunch(terms);
    }
    // Simulated from the owner at the observation block, at the gas price the launch step will carry (the escrow reads `tx.gasprice`).
    const request = { to: transaction.to, data: transaction.data, value: transaction.value, account: owner, blockNumber, ...stage === last ? { gasPrice } : {} };
    const { data, gasEstimate } = await simulateStep(rpc, stage, request, quote.symbol);
    if (stage === "reset" || stage === "approve") check(data === undefined || data === "0x" || data === `0x${"0".repeat(63)}1`,
      "APPROVAL_REJECTED", "Token approval returned false or malformed data");
    const estimatedGasCost = ceil(gasEstimate * gasPrice * 120n, 100n);
    check(nativeBalance >= bond + estimatedGasCost, "INSUFFICIENT_GAS", "Reserve the native operating bond plus gas for this step");
    await canonical(at);
    check(await rpc.getTransactionCount({ address: owner, blockTag: "pending" }) === pending, "NONCE_CHANGED", "Wallet activity changed during preparation; prepare again");
    return { ...at, stage, stages, transaction, owner, beneficiary, dealId: state.dealId, creatorAccount: state.creatorAccount, launched: false as const,
      launchFee: fee, deployerBondWei: bond, maxLaunchGasPrice: verified.maxLaunchGasPrice, quoteBalance: balance, nativeBalance, nonce: pending, gasPrice,
      gasEstimate, estimatedGasCost, ...localFloor, simulated: true as const,
      terms: { enforced: terms.enforced, accepted: terms.accepted, requiredVersion: terms.requiredVersion, termsHash: terms.termsHash, uri: terms.uri },
      ...duration ? { durationBlocks: duration.durationBlocks, secondsPerBlock: duration.secondsPerBlock, rateSample: duration.rateSample } : {},
      ...scheduling ? { plan: { startTime: startTime!, executionWindowEndsAt: startTime! + SCHEDULE_EXECUTION_WINDOW_SECONDS, tickerHeldUntil: startTime! + SCHEDULE_EXECUTION_WINDOW_SECONDS,
        cancellable: false as const } } : {} };
  }
  const prepareLaunch = (input: AuctionLaunchInput) => prepare(input, "launch");
  /** The same steps as `prepareLaunch`, ending in `schedule` (`scheduleAuctionLaunch`): the fee and the bond are taken now and held until `startTime`; there is no cancel. */
  const prepareScheduledLaunch = async (input: ScheduledLaunchInput) => {
    check(!!input && typeof input === "object", "INVALID_LAUNCH", "Launch input required");
    return prepare(input, "schedule", input.startTime);
  };
  return { prepareLaunch, prepareScheduledLaunch };
}
