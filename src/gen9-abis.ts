import { parseAbi } from "viem";

/**
 * Gen9 launch controller additions over Gen8: the floor cap. Gen9 redeploys the Gen8 stack unchanged except that the launch
 * controller's `_open` reverts `FloorPriceAboveMaximum` above `MAX_FLOOR_PRICE_WAD()`. This is a hand-declared fragment, not a
 * compiler ABI: the Gen8-family controller ABI is not shipped in this package. Signature and parameter names match the compiled Gen9
 * controller (oxley compiled graph a5de0335…).
 */
export const launchFloorCapAbi = parseAbi([
  "function MAX_FLOOR_PRICE_WAD() view returns (uint256)",
  "error FloorPriceAboveMaximum(uint256 floorPriceWad,uint256 maximum)",
]);
