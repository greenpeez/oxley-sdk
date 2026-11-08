import { MAX_FLOOR_PRICE_WAD, MINIMUM_GROSS_RAISE, MINIMUM_NET_RAISE } from "./controller-rules.js";
import { check, uint } from "./validation.js";

const Q96 = 1n << 96n, DENOMINATOR = 10n ** 36n;
const MAX_PRICE = 50_505_050_505n * Q96 / (4n * 10n ** 18n);
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** Every auction offers 300M coins (the Dynamic Bids hook's `OFFERED`). */
export const OFFERED_UNITS = 300_000_000n * 10n ** 18n;
/** The curve's own lowest floor (the adapter's `MIN_FLOOR_PRICE_WAD`) and the highest floor `minimumRaiseFloor` is searched up to, in `floorPriceWad` units. */
const CURVE_MINIMUM = 9_959_120_000_000_000_000n, SEARCH_CEILING = 10n ** 24n;

/** Mirrors the current adapter, including upward tick rounding and the vendor CCA ceiling. Throws `INVALID_FLOOR` for a floor the adapter itself refuses. */
export function quoteAuctionFloor(floorPriceWad: bigint) {
  uint(floorPriceWad);
  check(floorPriceWad >= CURVE_MINIMUM, "INVALID_FLOOR", "Floor is below the supported minimum");
  const raw = ceil(floorPriceWad * Q96, DENOMINATOR);
  const spacing = ceil(raw, 10_000n), tickSpacingQ96 = spacing < 2n ? 2n : spacing;
  const floorPriceQ96 = ceil(raw, tickSpacingQ96) * tickSpacingQ96;
  check(raw >= (1n << 32n) + 1n && tickSpacingQ96 < MAX_PRICE
    && floorPriceQ96 <= MAX_PRICE - tickSpacingQ96, "INVALID_FLOOR", "Floor exceeds supported CCA bounds");
  return { floorPriceQ96, tickSpacingQ96, effectiveFloorPriceWad: ceil(floorPriceQ96 * DENOMINATOR, Q96) };
}
/**
 * The Dynamic Bids hook registers an auction only when its effective floor can raise the controller's minimum gross raise:
 * `floorPriceQ96 * OFFERED >= ceil(minimumGrossRaise / 10) * 10 * 2^96`. A lower floor passes account setup and the fee approval, then the
 * launch transaction itself reverts. The minimum is $30,000 net (`MINIMUM_NET_RAISE`), 30,303,030,303 gross (`MINIMUM_GROSS_RAISE`). Throws
 * `INVALID_FLOOR` for a floor the adapter itself refuses (`quoteAuctionFloor`).
 */
export function floorReachesMinimumRaise(floorPriceWad: bigint): boolean {
  return quoteAuctionFloor(floorPriceWad).floorPriceQ96 * OFFERED_UNITS >= (MINIMUM_GROSS_RAISE + 9n) / 10n * 10n * Q96;
}
/** The exact lowest `floorPriceWad` that reaches the minimum raise (101,010,101,030,162,826,490, about $0.00010101 a coin). */
export function minimumRaiseFloor(): bigint {
  let low = CURVE_MINIMUM, high = SEARCH_CEILING;
  check(floorReachesMinimumRaise(high), "INVALID_FLOOR", "No supported floor reaches the minimum raise");
  while (low < high) {
    const middle = (low + high) / 2n;
    if (floorReachesMinimumRaise(middle)) high = middle; else low = middle + 1n;
  }
  return low;
}
/**
 * Refuses a launch floor the controller would reject: one below `minimumRaiseFloor()` (`FLOOR_BELOW_MINIMUM_RAISE`) or above the controller's
 * cap `MAX_FLOOR_PRICE_WAD` (`FLOOR_ABOVE_MAXIMUM`). Pure; it reads nothing from the chain.
 */
export function validateLaunchFloor(floorPriceWad: bigint): void {
  uint(floorPriceWad);
  check(floorPriceWad <= MAX_FLOOR_PRICE_WAD, "FLOOR_ABOVE_MAXIMUM",
    `The USDC floor price is above the maximum a launch allows; use a floor of at most ${MAX_FLOOR_PRICE_WAD} (floorPriceWad units)`);
  check(floorReachesMinimumRaise(floorPriceWad), "FLOOR_BELOW_MINIMUM_RAISE",
    `The USDC floor price is too low for the auction to reach its ${new Intl.NumberFormat("en-US").format(MINIMUM_NET_RAISE / 10n ** 6n)} USDC minimum raise; use a floor of at least ${minimumRaiseFloor()} (floorPriceWad units)`);
}
