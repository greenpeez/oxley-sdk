import { encodeFunctionData, zeroAddress, type Address } from "viem";
import { creatorAccountAbi } from "./launch-abis.js";
import { checkDurationBlocks } from "./launch-duration.js";
import { validateLaunchTerms } from "./launch-input.js";
import { SCHEDULE_MAX_LEAD_SECONDS, SCHEDULE_MIN_LEAD_SECONDS, SCHEDULED_EXECUTION_GAS_CAP, SCHEDULED_EXECUTION_MAX_GAS_PRICE } from "./schedule-rules.js";
import { address, check, OxleyError, sameAddress, uint } from "./validation.js";
import type { AuctionLaunchInput, LaunchTransaction } from "./launch-types.js";

function chain(value: number) { check(Number.isSafeInteger(value) && value > 0, "INVALID_CHAIN", "A positive chain ID is required"); }
const call = (chainId: number, creatorAccount: Address, data: LaunchTransaction["data"], extra: Partial<LaunchTransaction> = {}): LaunchTransaction => {
  chain(chainId); address(creatorAccount);
  return { chainId, to: creatorAccount, value: 0n, ...extra, data };
};

/**
 * `scheduleAuctionLaunch(terms, startTime)` on the creator account: the launch fee is pulled from the caller (approve the account first, as for a launch) and `value` is the
 * 0.5 HYPE bond, which the account holds with the terms until the start. `startTime` must be 15 minutes to 8 days after the block that includes the transaction (the
 * contract's bounds; `prepareScheduledLaunch` keeps an extra margin). There is no cancel: the funds leave through the launch or, after the window, a refund.
 */
export function buildScheduleAuctionLaunch(input: Omit<AuctionLaunchInput, "owner" | "draftSalt" | "beneficiary" | "secondsPerBlock" | "durationBlocks">
  & { chainId: number; creatorAccount: Address; durationBlocks: number; startTime: number; bondWei: bigint; gasPrice?: bigint; now?: number }): LaunchTransaction {
  chain(input.chainId); address(input.creatorAccount); uint(input.bondWei);
  validateLaunchTerms(input); checkDurationBlocks(input.auctionDurationHours, input.durationBlocks);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  check(Number.isSafeInteger(input.startTime) && input.startTime > 0, "INVALID_START_TIME", "startTime must be a whole number of Unix seconds");
  if (input.startTime < now + SCHEDULE_MIN_LEAD_SECONDS) throw new OxleyError("LAUNCH_START_TOO_SOON", "A scheduled launch starts at least 15 minutes from now");
  if (input.startTime > now + SCHEDULE_MAX_LEAD_SECONDS) throw new OxleyError("LAUNCH_START_TOO_FAR", "A scheduled launch starts at most 8 days from now");
  const terms = { name: input.name, symbol: input.symbol, floorPrice: input.floorPriceWad, lockDays: input.creatorLockDays, commitmentBps: input.listingCommitmentBps,
    requestedHours: input.auctionDurationHours, durationBlocks: input.durationBlocks };
  return call(input.chainId, input.creatorAccount, encodeFunctionData({ abi: creatorAccountAbi, functionName: "scheduleAuctionLaunch", args: [terms, BigInt(input.startTime)] }),
    { value: input.bondWei, ...input.gasPrice === undefined ? {} : { gasPrice: input.gasPrice } });
}
/**
 * `executeScheduledLaunch()`: opens the scheduled auction. Anyone may send it from the start for 24 hours; it posts nothing (the fee and bond were taken when the launch was
 * scheduled), and the bond escrow repays the sender's gas from that bond. The account reverts above 1 gwei, so `gasPrice`, when given, must be at most that, and `gas` at most
 * the 12,000,000 the escrow repays.
 */
export function buildExecuteScheduledLaunch(input: { chainId: number; creatorAccount: Address; gasPrice?: bigint; gas?: bigint }): LaunchTransaction {
  if (input.gasPrice !== undefined) { uint(input.gasPrice); check(input.gasPrice <= SCHEDULED_EXECUTION_MAX_GAS_PRICE, "GAS_PRICE_TOO_HIGH", "The account refuses an execution above 1 gwei"); }
  if (input.gas !== undefined) { uint(input.gas); check(input.gas <= SCHEDULED_EXECUTION_GAS_CAP, "GAS_LIMIT_TOO_HIGH", "The bond escrow repays at most 12,000,000 gas"); }
  return call(input.chainId, input.creatorAccount, encodeFunctionData({ abi: creatorAccountAbi, functionName: "executeScheduledLaunch" }),
    { ...input.gasPrice === undefined ? {} : { gasPrice: input.gasPrice }, ...input.gas === undefined ? {} : { gas: input.gas } });
}
/** `refundScheduledLaunch()`: anyone, once the 24 hour window has closed without a launch. The launch fee returns to the deployer and the bond becomes claimable by the deployer. */
export const buildRefundScheduledLaunch = (input: { chainId: number; creatorAccount: Address }): LaunchTransaction =>
  call(input.chainId, input.creatorAccount, encodeFunctionData({ abi: creatorAccountAbi, functionName: "refundScheduledLaunch" }));
/** `claimScheduledFee()`: anyone; pays a refunded launch fee that could not be sent at the refund (`scheduledFeeOwed`), to the deployer only. */
export const buildClaimScheduledFee = (input: { chainId: number; creatorAccount: Address }): LaunchTransaction =>
  call(input.chainId, input.creatorAccount, encodeFunctionData({ abi: creatorAccountAbi, functionName: "claimScheduledFee" }));

function recipient(value: Address, creatorAccount: Address) {
  address(value);
  check(!sameAddress(value, creatorAccount) && !sameAddress(value, zeroAddress), "INVALID_RECIPIENT", "The recipient cannot be the creator account itself");
}
/**
 * `claimBondRefund(recipient)`: only the original creator (the account's `bondBeneficiary`, fixed at creation and kept through any handover) may send it. It first withdraws
 * any credit the bond escrow could not pay the account, then pays the account's whole refund balance in native HYPE to `recipient` with a 30,000 gas call; a recipient that
 * cannot take that (a contract with a heavy receive) leaves the balance in place and the call returns `false`.
 */
export function buildClaimBondRefund(input: { chainId: number; creatorAccount: Address; recipient: Address }): LaunchTransaction {
  chain(input.chainId); address(input.creatorAccount); recipient(input.recipient, input.creatorAccount);
  return call(input.chainId, input.creatorAccount, encodeFunctionData({ abi: creatorAccountAbi, functionName: "claimBondRefund", args: [input.recipient] }));
}
/**
 * `claimFees(recipient)`: anyone may send it, but it pays only the fees credited to `recipient` (USDC; the current beneficiary accrues new fees, a previous one keeps what
 * was credited before a handover). It reverts `NotLaunched` before the launch and `FeesLocked` until the auction has succeeded and the creator lock has ended.
 */
export function buildClaimCreatorFees(input: { chainId: number; creatorAccount: Address; recipient: Address }): LaunchTransaction {
  chain(input.chainId); address(input.creatorAccount); recipient(input.recipient, input.creatorAccount);
  return call(input.chainId, input.creatorAccount, encodeFunctionData({ abi: creatorAccountAbi, functionName: "claimFees", args: [input.recipient] }));
}
