import { readTermsStatus } from "./client-terms.js";
import { buildClaimScheduledFee, buildExecuteScheduledLaunch, buildRefundScheduledLaunch } from "./creator-transactions.js";
import { creatorAccountAbi, launchBondAbi, launchControllerAbi } from "./launch-abis.js";
import { checkNonce, readWallet, simulateStep } from "./launch-step.js";
import { referenceTime, SCHEDULE_EXECUTION_WINDOW_SECONDS, SCHEDULED_EXECUTION_GAS_CAP, SCHEDULED_EXECUTION_MAX_GAS_PRICE, scheduledPhase, tickerKey,
  type ScheduledPhase } from "./schedule-rules.js";
import { address, check, OxleyError } from "./validation.js";
import type { Address } from "viem";
import type { Anchor } from "./types.js";
import type { LaunchContext } from "./launch-context.js";
import type { CreatorRef, LaunchReader, LaunchState } from "./launch-account.js";
import type { CallerOption, ScheduledAction } from "./launch-types.js";

/** The terms a creator account stored when it was scheduled, named as `AuctionLaunchInput` names them. They stay readable after the launch ran. */
export interface ScheduledTerms {
  readonly name: string; readonly symbol: string; readonly floorPriceWad: bigint; readonly creatorLockDays: number; readonly listingCommitmentBps: number;
  readonly auctionDurationHours: number; readonly durationBlocks: number;
}
/** Gas offered to a refund that cannot be simulated (a quiet chain): it writes a few slots and pays the launch fee back, far below this. */
const UNSIMULATED_REFUND_GAS = 500_000n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** Why a step is not offered in a phase: the contract's own refusal, as a code. */
const NOT_OFFERED: Readonly<Record<"execute" | "refund", Partial<Record<ScheduledPhase, [string, string]>>>> = {
  execute: { pending: ["SCHEDULE_NOT_DUE", "The scheduled launch has not reached its start"], expired: ["SCHEDULE_WINDOW_CLOSED", "The 24 hour execution window has closed; refund the launch instead"],
    executed: ["ALREADY_LAUNCHED", "The scheduled launch has already run"], refunded: ["NOT_SCHEDULED", "The schedule was refunded"], none: ["NOT_SCHEDULED", "This creator account has no scheduled launch"] },
  refund: { pending: ["SCHEDULE_NOT_EXPIRED", "A refund opens only after the 24 hour execution window has closed"], executable: ["SCHEDULE_NOT_EXPIRED", "The scheduled launch can still be executed; a refund opens only after its 24 hour window"],
    executed: ["ALREADY_LAUNCHED", "The scheduled launch has already run"], refunded: ["ALREADY_REFUNDED", "The schedule was already refunded"], none: ["NOT_SCHEDULED", "This creator account has no scheduled launch"] },
};

export function createScheduleActions(context: LaunchContext, reader: LaunchReader, clock: () => number) {
  const { rpc, deployment, pins, controller, verifyDeployment, canonical } = context;
  const chainId = deployment.chainId, symbol = deployment.quoteToken.symbol, bondWei = BigInt(deployment.launchBindings.deployerBondWei);
  const launchFee = BigInt(deployment.launchBindings.launchFeeBaseUnits);

  /**
   * A creator account's schedule at the observation block: the stored terms, the phase at the reference time (the head block's, or on a quiet chain the clock's) and what
   * the schedule offers. `executable` and `refundable` follow the contract: execution from the start to 24 hours after it (both inclusive), refund strictly after.
   */
  async function readSchedule(state: LaunchState, at: Anchor) {
    const time = referenceTime(at.timestamp, clock()), account = state.creatorAccount, blockNumber = at.blockNumber;
    const scheduled = account !== null && state.scheduledStart !== 0n;
    const read = <N extends "scheduledAuction" | "scheduledFeeOwed">(functionName: N) => rpc.readContract({ address: account!, abi: creatorAccountAbi, functionName, blockNumber });
    const [terms, feeOwed] = account ? await Promise.all([scheduled ? read("scheduledAuction") : null, read("scheduledFeeOwed")]) : [null, 0n];
    const stored: ScheduledTerms | null = terms && { name: terms[0], symbol: terms[1], floorPriceWad: terms[2], creatorLockDays: terms[3], listingCommitmentBps: terms[4],
      auctionDurationHours: terms[5], durationBlocks: terms[6] };
    const hold = stored && !state.launched
      ? await rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "tickerHold", args: [tickerKey(stored.symbol)], blockNumber }) : null;
    const phase = scheduledPhase(state, time.reference), startTime = scheduled ? Number(state.scheduledStart) : null;
    const windowEndsAt = startTime === null ? null : startTime + SCHEDULE_EXECUTION_WINDOW_SECONDS;
    return Object.freeze({ creatorAccount: account, phase, chainPhase: scheduledPhase(state, time.chain), launched: state.launched, startTime, windowEndsAt,
      secondsUntilStart: phase === "pending" ? startTime! - time.reference : null, secondsRemaining: phase === "executable" ? windowEndsAt! - time.reference : null,
      terms: stored, executable: phase === "executable", refundable: phase === "expired",
      /** The native bond the account holds for a schedule that has neither run nor been refunded (0.5 HYPE). */
      heldBondWei: ["pending", "executable", "expired"].includes(phase) ? bondWei : 0n,
      /** A refunded launch fee the deployer could not receive; `prepareClaimScheduledFee` retries it, to the deployer only. */
      feeOwed, bondRefundable: state.bondRefundable,
      tickerHold: hold && hold[1] !== 0n ? { holder: hold[0], until: Number(hold[1]) } : null, time });
  }
  type Schedule = Awaited<ReturnType<typeof readSchedule>>;

  async function prologue(input: CreatorRef & CallerOption) {
    check(!!input && typeof input === "object", "INVALID_LAUNCH", "Launch identity required");
    if (input.caller !== undefined) address(input.caller);
    const { blockNumber, blockHash, timestamp, ...verified } = await verifyDeployment(), at: Anchor = { blockNumber, blockHash, timestamp };
    const state = await reader.stateAt(input, at);
    // Whoever sends: the caller named, else the wallet named as the owner, else the account's creator. An account that does not exist has no schedule, which the step reports first.
    return { caller: (input.caller ?? input.owner ?? state.owner) as Address, at, verified, state };
  }
  /** Reports the schedule of a creator account: pending, executable, executed, expired (refundable), refunded, or none. */
  async function getScheduledLaunch(input: CreatorRef) {
    const { at, state } = await prologue(input), schedule = await readSchedule(state, at);
    await canonical(at);
    return { ...at, owner: state.owner, dealId: state.dealId, ...schedule };
  }
  function require(action: "execute" | "refund", schedule: Schedule) {
    const wanted = action === "execute" ? "executable" : "expired";
    if (schedule.phase === wanted) return;
    const [code, message] = NOT_OFFERED[action][schedule.phase] ?? ["NOT_SCHEDULED", "This creator account has no scheduled launch"];
    throw new OxleyError(code, message, { phase: schedule.phase, startTime: schedule.startTime, windowEndsAt: schedule.windowEndsAt, secondsUntilStart: schedule.secondsUntilStart,
      reference: schedule.time.reference });
  }
  /** What every account call returns beside its transaction. */
  const common = (at: Anchor, caller: Address, state: LaunchState, schedule: Schedule) => ({ ...at, owner: state.owner, caller, dealId: state.dealId,
    creatorAccount: state.creatorAccount!, launched: false as const, schedule });

  /**
   * `executeScheduledLaunch()`, open to anyone from the start for 24 hours: it opens the auction with the fee and the bond posted at scheduling, and the bond escrow repays the
   * caller's gas from that bond. The step carries the gas price (at most 1 gwei, which the account enforces) and a gas limit (the estimate with 20%, at most the 12,000,000 the
   * escrow repays). It is simulated from `caller`; on a quiet chain whose head predates the start it cannot be, and is returned with `simulated: false`.
   */
  async function executeAt(caller: Address, at: Anchor, verified: Awaited<ReturnType<typeof prologue>>["verified"], state: LaunchState, schedule: Schedule) {
    require("execute", schedule);
    check(verified.publicLaunchEnabled && !verified.entriesPaused, "LAUNCH_PAUSED", "Public launches are disabled or paused, so the scheduled launch would revert; it can be refunded after its window");
    const account = state.creatorAccount!, blockNumber = at.blockNumber;
    const [terms, wallet, repaidGas] = await Promise.all([readTermsStatus(rpc, deployment.termsRegistry.address, state.accountController!, at), readWallet(rpc, caller, blockNumber),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "SCHEDULED_LAUNCH_GAS", blockNumber })]);
    // What the bond repays an executor: at most this gas at at most the escrow's gas price cap, which are the figures the step is priced by.
    check(repaidGas === SCHEDULED_EXECUTION_GAS_CAP && verified.maxLaunchGasPrice === SCHEDULED_EXECUTION_MAX_GAS_PRICE, "SCHEDULE_RULES_MISMATCH",
      "The bond escrow repays an execution differently from this SDK's rules (12,000,000 gas at 1 gwei); do not execute against this release");
    check(!terms.enforced || terms.accepted, "CREATOR_TERMS_NOT_ACCEPTED", "The creator must accept the current Oxley terms before the scheduled launch can run");
    check(wallet.gasPrice <= SCHEDULED_EXECUTION_MAX_GAS_PRICE, "GAS_PRICE_TOO_HIGH", "The gas price is above the 1 gwei the account accepts for an execution; wait for a lower gas price and prepare again");
    const simulated = schedule.chainPhase === schedule.phase;
    let gasEstimate: bigint | null = null, gas = SCHEDULED_EXECUTION_GAS_CAP;
    const draft = buildExecuteScheduledLaunch({ chainId, creatorAccount: account, gasPrice: wallet.gasPrice });
    if (simulated) {
      // The keeper simulates with the full 12,000,000 gas; the limit that is returned is the estimate plus a fifth, never above what the escrow repays.
      ({ gasEstimate } = await simulateStep(rpc, "execute", { to: account, data: draft.data, value: 0n, account: caller, blockNumber, gasPrice: wallet.gasPrice, gas: SCHEDULED_EXECUTION_GAS_CAP }, symbol));
      check(gasEstimate <= SCHEDULED_EXECUTION_GAS_CAP, "SCHEDULE_EXECUTION_TOO_EXPENSIVE", "Executing this launch needs more gas than its bond repays; try again shortly");
      gas = ceil(gasEstimate * 120n, 100n) > SCHEDULED_EXECUTION_GAS_CAP ? SCHEDULED_EXECUTION_GAS_CAP : ceil(gasEstimate * 120n, 100n);
    }
    const estimatedGasCost = gas * wallet.gasPrice;
    check(wallet.native >= estimatedGasCost, "INSUFFICIENT_GAS", "The caller needs native HYPE for the execution's gas, which the creator's bond then repays");
    await canonical(at); await checkNonce(rpc, caller, wallet.nonce);
    return { ...common(at, caller, state, schedule), stage: "execute" as const, stages: ["execute" as const], simulated, simulationSkipped: simulated ? null : "QUIET_CHAIN_HEAD_BEFORE_START" as string | null,
      transaction: buildExecuteScheduledLaunch({ chainId, creatorAccount: account, gasPrice: wallet.gasPrice, gas }), nativeBalance: wallet.native, nonce: wallet.nonce,
      gasPrice: wallet.gasPrice, gasEstimate, gasLimit: gas, estimatedGasCost, reimbursedFromBond: true as const };
  }
  /**
   * `refundScheduledLaunch()`, open to anyone strictly after the 24 hour window without a launch: the launch fee goes back to the deployer (or, if the deployer cannot receive
   * it, is kept as `feeOwed` for `claimScheduledFee`) and the bond becomes claimable by the deployer with `claimBondRefund`. The caller pays the gas; nothing repays it.
   */
  async function refundAt(caller: Address, at: Anchor, state: LaunchState, schedule: Schedule) {
    require("refund", schedule);
    const account = state.creatorAccount!, wallet = await readWallet(rpc, caller, at.blockNumber), draft = buildRefundScheduledLaunch({ chainId, creatorAccount: account });
    const simulated = schedule.chainPhase === schedule.phase;
    let gasEstimate: bigint | null = null;
    if (simulated) ({ gasEstimate } = await simulateStep(rpc, "refund", { to: account, data: draft.data, value: 0n, account: caller, blockNumber: at.blockNumber }, symbol));
    const gas = gasEstimate === null ? UNSIMULATED_REFUND_GAS : ceil(gasEstimate * 120n, 100n), estimatedGasCost = gas * wallet.gasPrice;
    check(wallet.native >= estimatedGasCost, "INSUFFICIENT_GAS", "The caller needs native HYPE for the refund's gas");
    await canonical(at); await checkNonce(rpc, caller, wallet.nonce);
    return { ...common(at, caller, state, schedule), stage: "refund" as const, stages: ["refund" as const], simulated, simulationSkipped: simulated ? null : "QUIET_CHAIN_HEAD_BEFORE_REFUND_OPENS" as string | null,
      transaction: gasEstimate === null ? { ...draft, gas } : draft, nativeBalance: wallet.native, nonce: wallet.nonce, gasPrice: wallet.gasPrice, gasEstimate, estimatedGasCost,
      /** The fee returns to the deployer, the bond to the account's refund balance (claimed by the deployer). */
      refunds: { launchFee, bondWei } };
  }

  async function prepareExecuteScheduledLaunch(input: CreatorRef & CallerOption) {
    const { caller, at, verified, state } = await prologue(input), schedule = await readSchedule(state, at);
    return executeAt(caller, at, verified, state, schedule);
  }
  async function prepareRefundScheduledLaunch(input: CreatorRef & CallerOption) {
    const { caller, at, state } = await prologue(input), schedule = await readSchedule(state, at);
    return refundAt(caller, at, state, schedule);
  }
  /** `claimScheduledFee()`, open to anyone: pays a refunded launch fee that the deployer could not receive when the schedule was refunded, to the deployer only. */
  async function prepareClaimScheduledFee(input: CreatorRef & CallerOption) {
    const { caller, at, state } = await prologue(input), schedule = await readSchedule(state, at);
    if (schedule.feeOwed === 0n) throw new OxleyError("NOTHING_TO_CLAIM", "No refunded launch fee is owed to the deployer", { phase: schedule.phase });
    const account = state.creatorAccount!, wallet = await readWallet(rpc, caller, at.blockNumber), draft = buildClaimScheduledFee({ chainId, creatorAccount: account });
    const { gasEstimate } = await simulateStep(rpc, "claim-fee", { to: account, data: draft.data, value: 0n, account: caller, blockNumber: at.blockNumber }, symbol);
    const estimatedGasCost = ceil(gasEstimate * 120n, 100n) * wallet.gasPrice;
    check(wallet.native >= estimatedGasCost, "INSUFFICIENT_GAS", "The caller needs native HYPE for the claim's gas");
    await canonical(at); await checkNonce(rpc, caller, wallet.nonce);
    return { ...common(at, caller, state, schedule), stage: "claim-fee" as const, stages: ["claim-fee" as const], simulated: true as const, transaction: draft,
      nativeBalance: wallet.native, nonce: wallet.nonce, gasPrice: wallet.gasPrice, gasEstimate, estimatedGasCost, expectedAmount: schedule.feeOwed, recipient: state.bondBeneficiary! };
  }
  /**
   * What `prepareLaunch` and `prepareScheduledLaunch` return for an account that already has a schedule pending: nothing to send before the start (`scheduled`), the execution
   * during the window, and the refund after it. The owner is the caller.
   */
  async function routePending(id: CreatorRef, at: Anchor, verified: Awaited<ReturnType<typeof prologue>>["verified"], state: LaunchState) {
    const schedule = await readSchedule(state, at);
    if (schedule.phase === "executable") return executeAt(state.owner!, at, verified, state, schedule);
    if (schedule.phase === "expired") return refundAt(state.owner!, at, state, schedule);
    await canonical(at);
    return { ...common(at, state.owner!, state, schedule), stage: "scheduled" as const, stages: [] as readonly ScheduledAction[], transaction: null, simulated: false as const };
  }
  return { readSchedule, getScheduledLaunch, prepareExecuteScheduledLaunch, prepareRefundScheduledLaunch, prepareClaimScheduledFee, routePending };
}
export type ScheduleActions = ReturnType<typeof createScheduleActions>;
export type ScheduledLaunchInfo = Awaited<ReturnType<ScheduleActions["getScheduledLaunch"]>>;
