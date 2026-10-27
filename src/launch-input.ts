import { address, check, hash, uint } from "./validation.js";
import { auctionDurationBounds, blockRate } from "./launch-duration.js";
import type { AuctionLaunchInput } from "./launch-types.js";

const Q96 = 1n << 96n, DENOMINATOR = 10n ** 36n;
const MAX_PRICE = 50_505_050_505n * Q96 / (4n * 10n ** 18n);
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
function validateLaunchName(name: string) {
  check(typeof name === "string" && name.trim() === name && name.length > 0
    && new TextEncoder().encode(name).length <= 80, "INVALID_NAME", "Name must be trimmed and 1-80 UTF-8 bytes");
}
/** Mirrors the current adapter, including upward tick rounding and the vendor CCA ceiling. */
export function quoteAuctionFloor(floorPriceWad: bigint) {
  uint(floorPriceWad);
  check(floorPriceWad >= 9_959_120_000_000_000_000n, "INVALID_FLOOR", "Floor is below the supported minimum");
  const raw = ceil(floorPriceWad * Q96, DENOMINATOR);
  const spacing = ceil(raw, 10_000n), tickSpacingQ96 = spacing < 2n ? 2n : spacing;
  const floorPriceQ96 = ceil(raw, tickSpacingQ96) * tickSpacingQ96;
  check(raw >= (1n << 32n) + 1n && tickSpacingQ96 < MAX_PRICE
    && floorPriceQ96 <= MAX_PRICE - tickSpacingQ96, "INVALID_FLOOR", "Floor exceeds supported CCA bounds");
  return { floorPriceQ96, tickSpacingQ96, effectiveFloorPriceWad: ceil(floorPriceQ96 * DENOMINATOR, Q96) };
}
export function validateAuctionLaunch(input: AuctionLaunchInput): void {
  check(!!input && typeof input === "object", "INVALID_LAUNCH", "Launch input required");
  hash(input.dealId); address(input.owner);
  validateLaunchName(input.name);
  check(typeof input.symbol === "string" && /^[A-Z0-9]{1,10}$/.test(input.symbol),
    "INVALID_SYMBOL", "Symbol must contain 1-10 uppercase ASCII letters or digits");
  check([0, 30, 60].includes(input.creatorLockDays), "INVALID_LOCK", "Creator lock must be 0, 30 or 60 days");
  check([5000, 10000].includes(input.listingCommitmentBps), "INVALID_COMMITMENT", "Listing commitment must be 50% or 100%");
  check(Number.isInteger(input.auctionDurationHours) && input.auctionDurationHours >= 1 && input.auctionDurationHours <= 24,
    "INVALID_DURATION", "Auction duration must be 1-24 whole hours");
  if (input.secondsPerBlock !== undefined) blockRate(input.secondsPerBlock);
  if (input.durationBlocks !== undefined) {
    const { minimumBlocks, maximumBlocks } = auctionDurationBounds(input.auctionDurationHours);
    check(Number.isInteger(input.durationBlocks) && input.durationBlocks >= minimumBlocks && input.durationBlocks <= maximumBlocks,
      "INVALID_DURATION_BLOCKS", `durationBlocks must be an integer from ${minimumBlocks} to ${maximumBlocks} for ${input.auctionDurationHours} h`);
  }
  quoteAuctionFloor(input.floorPriceWad);
}
