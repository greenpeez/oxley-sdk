import { parseAbi } from "viem";

/**
 * Gen9 launch controller additions over Gen8: the floor cap. Gen9 redeploys the Gen8 stack unchanged except that the launch
 * controller's `_open` reverts `FloorPriceAboveMaximum` above `MAX_FLOOR_PRICE_WAD()`. Gen10 has the same cap. This is a
 * hand-declared fragment, not a compiler ABI: the Gen8-family controller ABI is not shipped in this package. Signature and
 * parameter names match the compiled Gen9 controller (oxley compiled graph a5de0335…).
 */
export const launchFloorCapAbi = parseAbi([
  "function MAX_FLOOR_PRICE_WAD() view returns (uint256)",
  "error FloorPriceAboveMaximum(uint256 floorPriceWad,uint256 maximum)",
]);

/**
 * The launch controller's minimum raise, which every Gen8-family controller exposes (an immutable set by the constructor) and which
 * differs by member: `minimumRaise()` is the net amount in USDC base units (Gen8 and Gen9 $50,000, Gen10 $30,000) and
 * `minimumGrossRaise()` is that amount grossed up for the 1% platform fee. Also a hand-declared fragment; the views are
 * unchanged since the shared controller base of Gen2.
 */
export const launchMinimumRaiseAbi = parseAbi([
  "function minimumRaise() view returns (uint256)",
  "function minimumGrossRaise() view returns (uint256)",
]);
