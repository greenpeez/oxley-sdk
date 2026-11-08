import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FLOOR_PRICE_WAD, MINIMUM_GROSS_RAISE, OxleyError } from "../src/index.js";
import { floorReachesMinimumRaise, minimumRaiseFloor, OFFERED_UNITS, quoteAuctionFloor, validateLaunchFloor } from "../src/launch.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const Q96 = 1n << 96n;
/** The gross raise a floor can reach if every coin offered sells at the floor: effective floor x 300M coins, in USDC base units (floors are in 24-decimal units, USDC has 6, coins 18). */
const raiseAt = (floorPriceWad: bigint) => quoteAuctionFloor(floorPriceWad).floorPriceQ96 * OFFERED_UNITS / Q96;
const dollars = (amount: bigint) => amount * 10n ** 6n;
/** A floor (24-decimal units) whose full sale raises about `usdc` dollars gross: 300M coins at floor / 1e24 dollars each. */
const floorFor = (usdc: bigint) => usdc * 10n ** 24n / 300_000_000n;
const messageOf = (floor: bigint) => { try { validateLaunchFloor(floor); } catch (error) { return (error as OxleyError).message; } throw new Error("accepted"); };

test("the lowest floor is the exact one that reaches the $30,000 minimum raise: about $0.00010101 a coin", () => {
  const lowest = minimumRaiseFloor();
  assert.equal(lowest, 101_010_101_030_162_826_490n); // the figure the app's fork rehearsal records for the $30,000 minimum
  assert.ok(floorReachesMinimumRaise(lowest)); assert.ok(!floorReachesMinimumRaise(lowest - 1n));
  // The hook's rule written out: effective floor x 300M coins >= ceil(gross / 10) * 10 * 2^96.
  assert.ok(quoteAuctionFloor(lowest).floorPriceQ96 * OFFERED_UNITS >= (MINIMUM_GROSS_RAISE + 9n) / 10n * 10n * Q96);
  assert.ok(quoteAuctionFloor(lowest - 1n).floorPriceQ96 * OFFERED_UNITS < (MINIMUM_GROSS_RAISE + 9n) / 10n * 10n * Q96);
  // The forms show a floor to four significant digits, rounded up so it can be typed: $0.0001011.
  const shown = (units: bigint) => { const scale = 10n ** BigInt(units.toString().length - 4); return (units + scale - 1n) / scale * scale; };
  assert.equal(shown(lowest), 101_100_000_000_000_000_000n);
});
test("launch validation accepts a floor that raises $30,400 or more and refuses anything below $30,303 gross", () => {
  for (const usdc of [30_400n, 33_000n, 40_000n, 50_000n, 51_000n]) {
    const floor = floorFor(usdc);
    assert.ok(raiseAt(floor) >= dollars(30_303n), String(usdc));
    assert.doesNotThrow(() => validateLaunchFloor(floor), `accepts a floor that raises about $${usdc}`);
    assert.ok(floorReachesMinimumRaise(floor), String(usdc));
  }
  for (const usdc of [29_000n, 30_000n, 30_300n]) {
    assert.throws(() => validateLaunchFloor(floorFor(usdc)), code("FLOOR_BELOW_MINIMUM_RAISE"), String(usdc));
    assert.ok(!floorReachesMinimumRaise(floorFor(usdc)), String(usdc));
  }
});
test("a floor one unit under the lowest is refused with the minimum raise and the lowest floor, in USDC only", () => {
  const message = messageOf(minimumRaiseFloor() - 1n);
  assert.equal(message, "The USDC floor price is too low for the auction to reach its 30,000 USDC minimum raise; use a floor of at least 101010101030162826490 (floorPriceWad units)");
  assert.doesNotMatch(message, /HYPE|KNTQ|native|graduat/i);
  assert.doesNotThrow(() => validateLaunchFloor(minimumRaiseFloor()));
});
test("the controller caps the floor at 1e21, and the cap is checked before the raise", () => {
  assert.doesNotThrow(() => validateLaunchFloor(MAX_FLOOR_PRICE_WAD));
  assert.throws(() => validateLaunchFloor(MAX_FLOOR_PRICE_WAD + 1n), code("FLOOR_ABOVE_MAXIMUM"));
  assert.match(messageOf(MAX_FLOOR_PRICE_WAD + 1n), /at most 1000000000000000000000/);
});
test("floors the adapter itself refuses and malformed input are not decided by the raise rule", () => {
  assert.throws(() => floorReachesMinimumRaise(9_959_119_999_999_999_999n), code("INVALID_FLOOR")); // below the curve's own minimum
  assert.throws(() => floorReachesMinimumRaise(10n ** 40n), code("INVALID_FLOOR")); // above the CCA bounds
  for (const bad of [0n, -1n, 1.5 as never, "1" as never]) assert.throws(() => validateLaunchFloor(bad), (error: unknown) => error instanceof OxleyError, String(bad));
});
