import { parseUnits } from "viem";
import { minimumRaiseFloor, quoteAuctionFloor, validateLaunchFloor } from "@oxley/sdk/launch";

/** Checks a launch floor before any transaction: the lowest floor that can raise the $30,000 minimum, the controller's cap and the adapter's tick rounding. */
export function checkFloor(usdcPerCoin: string) {
  const floorPriceWad = parseUnits(usdcPerCoin, 24); // 24 decimals for a human USDC-per-coin price
  validateLaunchFloor(floorPriceWad); // throws FLOOR_BELOW_MINIMUM_RAISE, FLOOR_ABOVE_MAXIMUM or INVALID_FLOOR
  return { floorPriceWad, lowestFloor: minimumRaiseFloor(), effective: quoteAuctionFloor(floorPriceWad) };
}
