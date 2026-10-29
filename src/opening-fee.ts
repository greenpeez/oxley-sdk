import { check } from "./validation.js";

/**
 * Mirror of the Gen3/Gen8 `ElysiumOpeningFee` schedule for countdowns and projections. The curve's own `quoteBuy` is the authority
 * for what a trade pays (it already includes this surcharge); verify the mirror with `surchargeWadAt(elapsed)` on a curve.
 */
export const OPENING_SURCHARGE_START_WAD = 180_000_000_000_000_000n;
export const OPENING_SURCHARGE_SECONDS = 60n;
export const STANDARD_TRADING_FEE_BPS = 200n;
const WAD = 10n ** 18n, HALF_LIFE = 10n;

/** 18% at the opening, halving every 10 s with linear interpolation inside each step, zero from 60 s. Exact at whole seconds. */
export function openingSurchargeWadAt(elapsedSeconds: bigint | number): bigint {
  check(typeof elapsedSeconds === "bigint" || Number.isSafeInteger(elapsedSeconds), "INVALID_AMOUNT", "Elapsed seconds must be an integer");
  const elapsed = BigInt(elapsedSeconds);
  check(elapsed >= 0n, "INVALID_AMOUNT", "Elapsed seconds must not be negative");
  if (elapsed >= OPENING_SURCHARGE_SECONDS) return 0n;
  const level = OPENING_SURCHARGE_START_WAD >> (elapsed / HALF_LIFE);
  return level - level * (elapsed % HALF_LIFE) / (2n * HALF_LIFE);
}
/** Surcharge on `gross` quote units, rounded up in favor of the curve reserve (as the contract does). */
export function openingSurchargeAmount(gross: bigint, rateWad: bigint): bigint {
  check(gross >= 0n && rateWad >= 0n && rateWad <= OPENING_SURCHARGE_START_WAD, "INVALID_AMOUNT", "Amount or rate is outside the opening schedule");
  return rateWad === 0n ? 0n : (gross * rateWad + WAD - 1n) / WAD;
}
/** Total buy fee in basis points for a surcharge rate: the standard 2% plus the surcharge rounded up (`currentBuyFeeBps`). */
export function buyFeeBps(rateWad: bigint): bigint {
  check(rateWad >= 0n && rateWad <= OPENING_SURCHARGE_START_WAD, "INVALID_AMOUNT", "Rate is outside the opening schedule");
  return STANDARD_TRADING_FEE_BPS + (rateWad * 10_000n + WAD - 1n) / WAD;
}
