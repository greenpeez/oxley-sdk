import { quoteAuctionFloor } from "./launch-input.js";
import { gen8FamilyMember, gen8MinimumGrossRaise, GEN8_FAMILY_NAMES, type Gen8FamilyId } from "./gen8-family.js";
import { check, uint } from "./validation.js";

const Q96 = 1n << 96n;
/** Every Gen8-family auction offers 300M coins (the Dynamic Bids hook's `OFFERED`). */
export const GEN8_OFFERED_UNITS = 300_000_000n * 10n ** 18n;
/** The curve's own lowest floor (the adapter's `MIN_FLOOR_PRICE_WAD`) and the highest floor `quoteAuctionFloor` is searched up to, in `floorPriceWad` units. */
const CURVE_MINIMUM = 9_959_120_000_000_000_000n, SEARCH_CEILING = 10n ** 24n;

function member(generation: Gen8FamilyId) {
  const found = gen8FamilyMember(generation);
  check(found !== undefined, "UNSUPPORTED_GENERATION", `Floor rules exist for ${GEN8_FAMILY_NAMES} launches only`);
  return found;
}
/**
 * The Dynamic Bids hook registers an auction only when its effective floor can raise the controller's minimum gross raise:
 * `floorPriceQ96 * OFFERED >= ceil(minimumGrossRaise / 10) * 10 * 2^96`. A lower floor passes account setup and the fee approval, then the
 * launch transaction itself reverts. The minimum is the generation's own: $30,000 net (30,303,030,303 gross) on Gen10, $50,000 net
 * (50,505,050,505 gross) on Gen8 and Gen9, so a floor that raises $30,000 to $50,000 at most reaches Gen10 and not Gen9. Throws
 * `INVALID_FLOOR` for a floor the adapter itself refuses (`quoteAuctionFloor`).
 */
export function floorReachesMinimumRaise(generation: Gen8FamilyId, floorPriceWad: bigint): boolean {
  member(generation);
  return quoteAuctionFloor(floorPriceWad).floorPriceQ96 * GEN8_OFFERED_UNITS >= (gen8MinimumGrossRaise(generation) + 9n) / 10n * 10n * Q96;
}
/** The exact lowest `floorPriceWad` that reaches the generation's minimum raise (Gen10: 101,010,101,030,162,826,490, about $0.00010101 a coin). */
export function minimumRaiseFloor(generation: Gen8FamilyId): bigint {
  let low = CURVE_MINIMUM, high = SEARCH_CEILING;
  check(floorReachesMinimumRaise(generation, high), "INVALID_FLOOR", "No supported floor reaches the minimum raise");
  while (low < high) {
    const middle = (low + high) / 2n;
    if (floorReachesMinimumRaise(generation, middle)) high = middle; else low = middle + 1n;
  }
  return low;
}
/**
 * Refuses a launch floor the generation's controller would reject: one below `minimumRaiseFloor(generation)` (`FLOOR_BELOW_MINIMUM_RAISE`)
 * or, for a member with a floor cap (Gen9, Gen10), above `maxFloorPriceWad` (`FLOOR_ABOVE_MAXIMUM`). Pure; it reads nothing from the chain.
 */
export function validateLaunchFloor(generation: Gen8FamilyId, floorPriceWad: bigint): void {
  const { label, minimumNetRaise, maxFloorPriceWad } = member(generation);
  uint(floorPriceWad);
  check(maxFloorPriceWad === undefined || floorPriceWad <= maxFloorPriceWad, "FLOOR_ABOVE_MAXIMUM",
    `The USDC floor price is above the maximum a ${label} launch allows; use a floor of at most ${maxFloorPriceWad} (floorPriceWad units)`);
  check(floorReachesMinimumRaise(generation, floorPriceWad), "FLOOR_BELOW_MINIMUM_RAISE",
    `The USDC floor price is too low for the auction to reach its ${new Intl.NumberFormat("en-US").format(minimumNetRaise / 10n ** 6n)} USDC minimum raise on ${label}; use a floor of at least ${minimumRaiseFloor(generation)} (floorPriceWad units)`);
}
