import { keccak256, stringToHex, type Hex } from "viem";
import { OxleyError } from "./validation.js";

/**
 * The scheduled-launch rules of `ElysiumCreatorAccountGen8` (`MIN_LEAD`, `MAX_LEAD`, `EXECUTION_WINDOW`) and of the launch controller (`HOLD_COOLDOWN`), in seconds.
 * The launch client reads each from the contracts before it prepares a `schedule` step and refuses the release (`SCHEDULE_RULES_MISMATCH`) if any differs.
 */
export const SCHEDULE_MIN_LEAD_SECONDS = 15 * 60;
export const SCHEDULE_MAX_LEAD_SECONDS = 8 * 86_400;
/** A scheduled launch can be executed from its start for 24 hours; after that it can only be refunded. */
export const SCHEDULE_EXECUTION_WINDOW_SECONDS = 24 * 3_600;
/** After a hold lapses unused, nobody may schedule its ticker for this long; launching it stays open. */
export const SCHEDULE_HOLD_COOLDOWN_SECONDS = 3 * 86_400;
/** The account refuses a name over 80 bytes and a dry run over 10,000,000 gas when it schedules. */
export const SCHEDULE_MAX_NAME_BYTES = 80n;
export const SCHEDULE_MAX_SIMULATED_GAS = 10_000_000n;
/** The bond escrow repays an executor at most 12,000,000 gas at at most 1 gwei (`SCHEDULED_LAUNCH_GAS`, `MAX_GAS_PRICE`); the account itself reverts `GasPriceTooHigh` above 1 gwei. */
export const SCHEDULED_EXECUTION_GAS_CAP = 12_000_000n;
export const SCHEDULED_EXECUTION_MAX_GAS_PRICE = 1_000_000_000n;
/**
 * The live app's margins on a start time (`SCHEDULE_SERVER_MIN_LEAD`, `SCHEDULE_ACCEPTED_MAX_LEAD`): the contract measures the start against the block that includes the
 * schedule, so a start must clear its 15 minute minimum by the time the step takes to sign (three minutes) and stay an hour short of its 8 day maximum, because Elysium
 * makes no empty blocks and a dry run against an old head sees an earlier clock.
 */
export const SCHEDULE_START_EARLY_MARGIN_SECONDS = 180;
export const SCHEDULE_START_LATE_MARGIN_SECONDS = 3_600;
/** A head block this much older than the clock is a quiet chain (no empty blocks), not a lagging node; the clock then stands in for it, less a minute of skew. */
export const QUIET_HEAD_SECONDS = 600;
export const CLOCK_SKEW_SECONDS = 60;

/** The earliest and latest start the SDK prepares at `now` (Unix seconds). */
export const scheduleStartBounds = (now: number) => Object.freeze({
  earliest: now + SCHEDULE_MIN_LEAD_SECONDS + SCHEDULE_START_EARLY_MARGIN_SECONDS, latest: now + SCHEDULE_MAX_LEAD_SECONDS - SCHEDULE_START_LATE_MARGIN_SECONDS });
/** Refuses a start the contract (or the app's margins on it) would refuse: whole Unix seconds, from 18 minutes to 7 days 23 hours ahead of `now`. */
export function validateScheduleStart(startTime: unknown, now: number): asserts startTime is number {
  if (typeof startTime !== "number" || !Number.isSafeInteger(startTime) || startTime <= 0) {
    throw new OxleyError("INVALID_START_TIME", "startTime must be a whole number of Unix seconds");
  }
  const bounds = scheduleStartBounds(now);
  if (startTime < bounds.earliest) throw new OxleyError("LAUNCH_START_TOO_SOON", "Choose a start at least 18 minutes from now (the contract's minimum is 15 minutes)", { ...bounds, now });
  if (startTime > bounds.latest) throw new OxleyError("LAUNCH_START_TOO_FAR", "Choose a start at most 7 days and 23 hours from now (the contract's maximum is 8 days)", { ...bounds, now });
}
/** The controller's key for a ticker hold: keccak256 of the uppercase symbol (`ElysiumTickerPolicy.canonicalKey`). */
export const tickerKey = (symbol: string): Hex => keccak256(stringToHex(symbol.toUpperCase()));
/** The first minute a ticker whose hold lapsed at `until` can be scheduled again; undefined when it is not cooling at `now`. */
export const tickerCooldownEnd = (until: number, now: number): number | undefined =>
  until > 0 && until < now && now <= until + SCHEDULE_HOLD_COOLDOWN_SECONDS ? Math.ceil((until + SCHEDULE_HOLD_COOLDOWN_SECONDS + 1) / 60) * 60 : undefined;

/**
 * Where a creator account's schedule stands: `pending` before the start, `executable` from the start for 24 hours (inclusive), `expired` after the window without a launch (the
 * only state `refundScheduledLaunch` accepts), `executed` once a scheduled launch ran, `refunded` after a refund while its bond is still in the account, `none` otherwise
 * (never scheduled, an immediate launch, or refunded and claimed: the account keeps no record of the last two).
 */
export type ScheduledPhase = "none" | "pending" | "executable" | "expired" | "executed" | "refunded";
export function scheduledPhase(state: { launched: boolean; scheduledStart: bigint; bondRefundable: bigint }, time: number): ScheduledPhase {
  // `executeScheduledLaunch` never clears `scheduledStart`, so a launched account that still has one ran its schedule; an immediate launch has none.
  if (state.launched) return state.scheduledStart === 0n ? "none" : "executed";
  if (state.scheduledStart === 0n) return state.bondRefundable > 0n ? "refunded" : "none";
  const start = Number(state.scheduledStart);
  return time < start ? "pending" : time <= start + SCHEDULE_EXECUTION_WINDOW_SECONDS ? "executable" : "expired";
}
/**
 * The time a phase is judged at. A live chain's head timestamp is the clock a simulation runs at, so it decides. On a quiet chain (head at least 10 minutes behind the
 * clock) the head says nothing about now: the clock less a minute of skew stands in, and a step whose phase the head contradicts cannot be simulated (the transaction's own
 * block will carry the real time), which the step reports as `simulated: false`.
 */
export function referenceTime(headTimestamp: bigint, clock: number) {
  const chain = Number(headTimestamp), quiet = clock - chain >= QUIET_HEAD_SECONDS;
  return Object.freeze({ chain, clock, quiet, reference: quiet ? Math.max(chain, clock - CLOCK_SKEW_SECONDS) : chain });
}
export type ScheduleTime = ReturnType<typeof referenceTime>;
