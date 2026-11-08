import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { auctionDurationBounds, blockRate, checkDurationBlocks } from "./launch-duration.js";
import { validateLaunchFloor } from "./launch-floor.js";
import { address, check, hash } from "./validation.js";
import type { AuctionLaunchInput } from "./launch-types.js";

/** The controller's `LAUNCH_NAMESPACE`: creator ownership is part of the deal id. */
const LAUNCH_NAMESPACE = keccak256(toHex("OXLEY_AUCTION_LAUNCH_GEN6"));
/** The controller's `dealIdFor(creator, draftSalt)`, computed locally (the launch client also reads the controller's answer and refuses any difference). */
export function launchDealId(input: { chainId: number; controller: Address; owner: Address; draftSalt: Hex }): Hex {
  check(Number.isSafeInteger(input.chainId) && input.chainId > 0, "INVALID_CHAIN", "A positive chain ID is required");
  address(input.controller); address(input.owner); hash(input.draftSalt);
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
    [LAUNCH_NAMESPACE, BigInt(input.chainId), input.controller, input.owner, input.draftSalt]));
}
/** A fresh random nonzero bytes32 for `AuctionLaunchInput.draftSalt`. Generate it once per launch and persist it before the first transaction. */
export function newDraftSalt(): Hex {
  const bytes = new Uint8Array(32);
  do globalThis.crypto.getRandomValues(bytes); while (bytes.every(byte => byte === 0));
  return toHex(bytes);
}
export type LaunchTerms = Pick<AuctionLaunchInput, "name" | "symbol" | "floorPriceWad" | "creatorLockDays" | "listingCommitmentBps" | "auctionDurationHours">;
/** The terms of one launch, as the contracts and the application rule on them; everything here can be known without a chain read. */
export function validateLaunchTerms(input: LaunchTerms): void {
  check(!!input && typeof input === "object", "INVALID_LAUNCH", "Launch input required");
  check(typeof input.name === "string" && input.name.trim() === input.name && input.name.length > 0 && new TextEncoder().encode(input.name).length <= 80,
    "INVALID_NAME", "Name must be trimmed and 1-80 UTF-8 bytes");
  check(typeof input.symbol === "string" && /^[A-Z0-9]{1,10}$/.test(input.symbol), "INVALID_SYMBOL", "Symbol must contain 1-10 uppercase ASCII letters or digits");
  check(input.symbol !== "OXY", "TICKER_RESERVED", "The ticker OXY is reserved");
  check([0, 30, 60].includes(input.creatorLockDays), "INVALID_LOCK", "Creator lock must be 0, 30 or 60 days");
  check([0, 5000, 10000].includes(input.listingCommitmentBps), "INVALID_COMMITMENT", "Listing commitment must be 0%, 50% or 100%");
  auctionDurationBounds(input.auctionDurationHours);
  // The same floor rules the controller applies: the 1e21 cap, the lowest floor that can raise the $30,000 net minimum, and the adapter's own bounds.
  validateLaunchFloor(input.floorPriceWad);
}
export function validateAuctionLaunch(input: AuctionLaunchInput): void {
  check(!!input && typeof input === "object", "INVALID_LAUNCH", "Launch input required");
  address(input.owner); hash(input.draftSalt);
  if (input.beneficiary !== undefined) address(input.beneficiary);
  validateLaunchTerms(input);
  if (input.secondsPerBlock !== undefined) blockRate(input.secondsPerBlock);
  if (input.durationBlocks !== undefined) checkDurationBlocks(input.auctionDurationHours, input.durationBlocks);
}
