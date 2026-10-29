import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeErrorResult, type Hex } from "viem";
import { buyFeeBps, decodeOxleyRevert, openingSurchargeAmount, openingSurchargeWadAt, OxleyError, OPENING_SURCHARGE_START_WAD } from "../src/index.js";
import { oxleyRevertAbi } from "../src/abis.js";
import { addr } from "./support/chain.js";

const account = addr(8);
const encodeError = (errorName: string, args: unknown[]): Hex => encodeErrorResult({ abi: oxleyRevertAbi, errorName, args } as never);

test("terms and curve trade reverts decode to short messages", () => {
  const data = (name: string, args: unknown[] = []) => ({ data: encodeError(name, args) });
  const terms = decodeOxleyRevert(data("TermsNotAccepted", [account, 2n, 1n]));
  assert.equal(terms?.name, "TermsNotAccepted"); assert.deepEqual(terms?.args, [account, 2n, 1n]);
  assert.match(terms!.message, /accept the current Oxley terms/);
  assert.equal(decodeOxleyRevert(data("BuysPaused"))?.name, "BuysPaused");
  assert.match(decodeOxleyRevert(data("MinimumNotMet"))!.message, /minimum/);
  assert.equal(decodeOxleyRevert(data("DeadlineExpired"))?.name, "DeadlineExpired");
});
test("the opening surcharge mirror follows the owner-locked schedule", () => {
  // Contract documentation table: total buy fee = standard 2% plus the surcharge (rounded up to a basis point).
  const total: [number, bigint][] = [[0, 2000n], [5, 1550n], [10, 1100n], [20, 650n], [30, 425n], [45, 285n], [59, 231n], [60, 200n], [600, 200n]];
  for (const [elapsed, bps] of total) assert.equal(buyFeeBps(openingSurchargeWadAt(elapsed)), bps, `t=${elapsed}`);
  const rates = [[0, OPENING_SURCHARGE_START_WAD], [1, 171_000_000_000_000_000n], [5, 135_000_000_000_000_000n], [10, 90_000_000_000_000_000n],
    [45, 8_437_500_000_000_000n], [59, 3_093_750_000_000_000n], [60, 0n]] as const;
  for (const [elapsed, rate] of rates) assert.equal(openingSurchargeWadAt(elapsed), rate, `t=${elapsed}`);
  assert.equal(openingSurchargeWadAt(5n), 135_000_000_000_000_000n);
  let previous = openingSurchargeWadAt(0);
  for (let t = 1; t <= 120; t++) { const next = openingSurchargeWadAt(t); assert.ok(next <= previous, `non-increasing at ${t}`); previous = next; }
  assert.equal(openingSurchargeAmount(1_000_001n, OPENING_SURCHARGE_START_WAD), 180_001n);
  assert.equal(openingSurchargeAmount(10_000_000n, 0n), 0n);
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => openingSurchargeWadAt(bad), OxleyError);
  assert.throws(() => openingSurchargeWadAt(-1n), OxleyError);
  assert.throws(() => openingSurchargeAmount(1n, OPENING_SURCHARGE_START_WAD + 1n), OxleyError);
  assert.throws(() => buyFeeBps(-1n), OxleyError);
});
