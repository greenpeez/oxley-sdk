import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseError, RawContractError, encodeErrorResult, keccak256, slice, toHex, type Hex } from "viem";
import { decodeOxleyRevert, GEN9_MAX_FLOOR_PRICE_WAD, GEN8_FAMILY, launchFloorCapAbi as fromIndex } from "../src/index.js";
import { launchFloorCapAbi, oxleyRevertAbi } from "../src/abis.js";
import { launchFloorCapAbi as fromAuctions } from "../src/auctions.js";
import { launchFloorCapAbi as fromLaunch } from "../src/launch.js";
import { addr } from "./support/chain.js";

const selector = (signature: string) => slice(keccak256(toHex(signature)), 0, 4);
const floor = 2n * 10n ** 21n, maximum = GEN9_MAX_FLOOR_PRICE_WAD;
const tooHigh = (args: readonly [bigint, bigint] = [floor, maximum]): Hex => encodeErrorResult({ abi: launchFloorCapAbi, errorName: "FloorPriceAboveMaximum", args });

test("the floor cap fragment is exactly the owner-given signature and getter, exported from every entry point", () => {
  const [getter, error] = [launchFloorCapAbi.find(item => item.type === "function"), launchFloorCapAbi.find(item => item.type === "error")];
  assert.deepEqual([launchFloorCapAbi.length, getter?.name, getter?.stateMutability, getter?.inputs.length, getter?.outputs.map(output => output.type)],
    [2, "MAX_FLOOR_PRICE_WAD", "view", 0, ["uint256"]]);
  assert.deepEqual([error?.name, error?.inputs.map(input => input.type)], ["FloorPriceAboveMaximum", ["uint256", "uint256"]]);
  // Only the types decide the selector; the parameter names are descriptive guesses.
  assert.equal(tooHigh().slice(0, 10), selector("FloorPriceAboveMaximum(uint256,uint256)"));
  assert.equal(encodeErrorResult({ abi: launchFloorCapAbi, errorName: "FloorPriceAboveMaximum", args: [1n, 2n] }).length, 10 + 128);
  assert.equal(fromIndex, launchFloorCapAbi); assert.equal(fromAuctions, launchFloorCapAbi); assert.equal(fromLaunch, launchFloorCapAbi);
  // The released revert set is untouched, so Gen8 decoding and its compiled-ABI evidence do not change.
  assert.ok(!(oxleyRevertAbi as readonly { type: string; name?: string }[]).some(item => item.name === "FloorPriceAboveMaximum"));
  assert.deepEqual([GEN8_FAMILY.gen8.maxFloorPriceWad, GEN8_FAMILY.gen9.maxFloorPriceWad, GEN8_FAMILY.gen10.maxFloorPriceWad, maximum], [undefined, 10n ** 21n, 10n ** 21n, 10n ** 21n]);
});
test("FloorPriceAboveMaximum decodes from raw data and wallet or RPC error shapes into a USDC floor message", () => {
  const data = tooHigh();
  for (const wrapped of [data, new BaseError("Execution reverted", { cause: new RawContractError({ data }) }), { error: { code: 3, data } }, { data: { data } }]) {
    const decoded = decodeOxleyRevert(wrapped);
    assert.ok(decoded); assert.equal(decoded.name, "FloorPriceAboveMaximum"); assert.deepEqual(decoded.args, [floor, maximum]);
    assert.match(decoded.message, /^The USDC floor price is above the maximum this release allows; use a floor of at most 1000000000000000000000 \(floorPriceWad units\)$/);
    assert.doesNotMatch(decoded.message, /HYPE|KNTQ|native/i);
    assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.args));
  }
  assert.match(decodeOxleyRevert(data, { quoteSymbol: "Oxy-USDC" })!.message, /^The Oxy-USDC floor price is above the maximum/);
  for (const generation of ["gen8", "gen9", "gen10"] as const) assert.equal(decodeOxleyRevert(data, { generation })?.name, "FloorPriceAboveMaximum", generation);
  // The limit in the message is the revert's own second argument, not the SDK's mirror of it.
  assert.match(decodeOxleyRevert(tooHigh([5n, 3n]))!.message, /at most 3 /);
});
test("anything that is not a complete FloorPriceAboveMaximum is not decoded as one", () => {
  const data = tooHigh();
  for (const other of [data.slice(0, 10), data.slice(0, 10 + 64), `${selector("FloorPriceAboveMaximum(uint256)")}${"00".repeat(32)}`, "0xdeadbeef", "0x", null, new Error("x")]) {
    assert.equal(decodeOxleyRevert(other)?.name, undefined, String(other));
  }
});
test("shared errors keep their per-generation wording and Gen9 and Gen10 word WalletCapExceeded like Gen8", () => {
  const cap = encodeErrorResult({ abi: oxleyRevertAbi, errorName: "WalletCapExceeded", args: [addr(9), 60_000_000_000n, 5_050_505_051n] });
  const message = (generation?: "gen2" | "gen3" | "gen8" | "gen9" | "gen10") => decodeOxleyRevert(cap, { generation })!.message;
  assert.equal(message("gen8"), "You can bid up to 5050.505051 USDC more on this auction");
  assert.equal(message("gen9"), message("gen8")); assert.equal(message("gen10"), message("gen8"));
  // Gen10's opening ceiling is $3,030.30 (ceil(30,303,030,303 / 10)); the wording is the remaining allowance the revert itself carries.
  const gen10 = encodeErrorResult({ abi: oxleyRevertAbi, errorName: "WalletCapExceeded", args: [addr(9), 60_000_000_000n, 3_030_303_031n] });
  assert.equal(decodeOxleyRevert(gen10, { generation: "gen10" })!.message, "You can bid up to 3030.303031 USDC more on this auction");
  assert.match(message("gen3"), /until this auction has broad support/); assert.equal(message(), message("gen2"));
});
