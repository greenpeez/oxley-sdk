import assert from "node:assert/strict";
import { test } from "node:test";
import { GEN8_FAMILY_IDS, gen8MinimumGrossRaise, OxleyError, type Gen8FamilyId } from "../src/index.js";
import { floorReachesMinimumRaise, GEN8_OFFERED_UNITS, minimumRaiseFloor, quoteAuctionFloor, validateLaunchFloor } from "../src/launch.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const Q96 = 1n << 96n;
/** The gross raise a floor can reach if every coin offered sells at the floor: effective floor x 300M coins, in USDC base units (floors are in 24-decimal units, USDC has 6, coins 18). */
const raiseAt = (floorPriceWad: bigint) => quoteAuctionFloor(floorPriceWad).floorPriceQ96 * GEN8_OFFERED_UNITS / Q96;
const dollars = (amount: bigint) => amount * 10n ** 6n;
/** A floor (24-decimal units) whose full sale raises about `usdc` dollars gross: 300M coins at floor / 1e24 dollars each. */
const floorFor = (usdc: bigint) => usdc * 10n ** 24n / 300_000_000n;

test("the lowest floor of each generation is the exact one that reaches its minimum raise: Gen10 $0.00010101, Gen8 and Gen9 $0.00016835", () => {
  assert.equal(minimumRaiseFloor("gen10"), 101_010_101_030_162_826_490n); // the figure the app's fork rehearsal records for the $30,000 minimum
  assert.equal(minimumRaiseFloor("gen9"), 168_350_168_257_386_965_981n); assert.equal(minimumRaiseFloor("gen8"), minimumRaiseFloor("gen9"));
  for (const id of GEN8_FAMILY_IDS) {
    const lowest = minimumRaiseFloor(id);
    assert.ok(floorReachesMinimumRaise(id, lowest), id); assert.ok(!floorReachesMinimumRaise(id, lowest - 1n), id);
    // The hook's rule written out: effective floor x 300M coins >= ceil(gross / 10) * 10 * 2^96.
    const gross = gen8MinimumGrossRaise(id), floorQ96 = quoteAuctionFloor(lowest).floorPriceQ96;
    assert.ok(floorQ96 * GEN8_OFFERED_UNITS >= (gross + 9n) / 10n * 10n * Q96, id);
    assert.ok(quoteAuctionFloor(lowest - 1n).floorPriceQ96 * GEN8_OFFERED_UNITS < (gross + 9n) / 10n * 10n * Q96, id);
  }
  // The forms show a floor to four significant digits, rounded up so it can be typed: $0.0001011 (Gen10) and $0.0001684 (Gen8, Gen9).
  const shown = (units: bigint) => { const scale = 10n ** BigInt(units.toString().length - 4); return (units + scale - 1n) / scale * scale; };
  assert.deepEqual([shown(minimumRaiseFloor("gen10")), shown(minimumRaiseFloor("gen9"))], [101_100_000_000_000_000_000n, 168_400_000_000_000_000_000n]);
  assert.ok(minimumRaiseFloor("gen10") < minimumRaiseFloor("gen9"));
});
test("launch validation accepts raises from $30,000 to $50,000 on Gen10 and keeps refusing them on Gen8 and Gen9", () => {
  // Floors whose full sale raises $30,400, $33,000, $40,000, $50,000 and $50,500 gross: all are at or above Gen10's $30,303.03 gross minimum.
  for (const usdc of [30_400n, 33_000n, 40_000n, 50_000n, 50_500n]) {
    const floor = floorFor(usdc);
    assert.ok(raiseAt(floor) >= dollars(30_303n), String(usdc));
    assert.doesNotThrow(() => validateLaunchFloor("gen10", floor), `Gen10 accepts a floor that raises about $${usdc}`);
    assert.ok(floorReachesMinimumRaise("gen10", floor), String(usdc));
    for (const id of ["gen8", "gen9"] as const) {
      assert.throws(() => validateLaunchFloor(id, floor), code("FLOOR_BELOW_MINIMUM_RAISE"), `${id} refuses a floor that raises about $${usdc}`);
      assert.ok(!floorReachesMinimumRaise(id, floor), `${id} ${usdc}`);
    }
  }
  // $50,505.05 gross is Gen8 and Gen9's own minimum: a floor that raises $51,000 passes everywhere.
  for (const id of GEN8_FAMILY_IDS) assert.doesNotThrow(() => validateLaunchFloor(id, floorFor(51_000n)), id);
  // Below Gen10's minimum nothing passes.
  for (const usdc of [29_000n, 30_000n, 30_300n]) for (const id of GEN8_FAMILY_IDS) {
    assert.throws(() => validateLaunchFloor(id, floorFor(usdc)), code("FLOOR_BELOW_MINIMUM_RAISE"), `${id} ${usdc}`);
  }
});
test("a floor one unit under a generation's lowest is refused with that generation's own minimum, in USDC only", () => {
  const messageOf = (id: Gen8FamilyId, floor: bigint) => { try { validateLaunchFloor(id, floor); } catch (error) { return (error as OxleyError).message; } throw new Error("accepted"); };
  assert.equal(messageOf("gen10", minimumRaiseFloor("gen10") - 1n), "The USDC floor price is too low for the auction to reach its 30,000 USDC minimum raise on Gen10; use a floor of at least 101010101030162826490 (floorPriceWad units)");
  assert.equal(messageOf("gen9", minimumRaiseFloor("gen9") - 1n), "The USDC floor price is too low for the auction to reach its 50,000 USDC minimum raise on Gen9; use a floor of at least 168350168257386965981 (floorPriceWad units)");
  assert.match(messageOf("gen8", minimumRaiseFloor("gen8") - 1n), /50,000 USDC minimum raise on Gen8/);
  for (const id of GEN8_FAMILY_IDS) assert.doesNotMatch(messageOf(id, minimumRaiseFloor(id) - 1n), /HYPE|KNTQ|native|graduat/i);
  for (const id of GEN8_FAMILY_IDS) assert.doesNotThrow(() => validateLaunchFloor(id, minimumRaiseFloor(id)), id);
});
test("Gen9 and Gen10 cap the floor at 1e21 and Gen8 does not; the cap is checked before the raise", () => {
  const cap = 10n ** 21n;
  for (const id of ["gen9", "gen10"] as const) {
    assert.doesNotThrow(() => validateLaunchFloor(id, cap), id);
    assert.throws(() => validateLaunchFloor(id, cap + 1n), code("FLOOR_ABOVE_MAXIMUM"), id);
  }
  assert.throws(() => validateLaunchFloor("gen10", cap + 1n), /at most 1000000000000000000000/);
  assert.doesNotThrow(() => validateLaunchFloor("gen8", cap + 1n));
});
test("floors the adapter itself refuses, malformed input and non-family generations are not decided by the raise rule", () => {
  assert.throws(() => floorReachesMinimumRaise("gen10", 9_959_119_999_999_999_999n), code("INVALID_FLOOR")); // below the curve's own minimum
  for (const bad of [0n, -1n, 1.5 as never, "1" as never]) assert.throws(() => validateLaunchFloor("gen10", bad), (error: unknown) => error instanceof OxleyError, String(bad));
  for (const generation of ["gen3", "gen2", "flat-fee", "gen11", "Gen10", "toString", undefined] as never[]) {
    assert.throws(() => validateLaunchFloor(generation, floorFor(60_000n)), code("UNSUPPORTED_GENERATION"), String(generation));
    assert.throws(() => floorReachesMinimumRaise(generation, floorFor(60_000n)), code("UNSUPPORTED_GENERATION"), String(generation));
    assert.throws(() => minimumRaiseFloor(generation), code("UNSUPPORTED_GENERATION"), String(generation));
  }
});
