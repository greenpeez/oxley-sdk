import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseError, RawContractError, encodeErrorResult, keccak256, slice, toHex, type Hex } from "viem";
import { decodeOxleyRevert, MAX_FLOOR_PRICE_WAD, launchFloorCapAbi as fromIndex } from "../src/index.js";
import { launchFloorCapAbi, oxleyRevertAbi } from "../src/abis.js";
import { launchFloorCapAbi as fromAuctions } from "../src/auctions.js";
import { launchFloorCapAbi as fromLaunch } from "../src/launch.js";
import { addr } from "./support/chain.js";

const selector = (signature: string) => slice(keccak256(toHex(signature)), 0, 4);
const floor = 2n * 10n ** 21n, maximum = MAX_FLOOR_PRICE_WAD;
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
  // The compiled-ABI error set is untouched: the floor cap error is decoded from its own fragment.
  assert.ok(!(oxleyRevertAbi as readonly { type: string; name?: string }[]).some(item => item.name === "FloorPriceAboveMaximum"));
  assert.equal(maximum, 10n ** 21n);
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
  // The limit in the message is the revert's own second argument, not the SDK's mirror of it.
  assert.match(decodeOxleyRevert(tooHigh([5n, 3n]))!.message, /at most 3 /);
});
test("anything that is not a complete FloorPriceAboveMaximum is not decoded as one", () => {
  const data = tooHigh();
  for (const other of [data.slice(0, 10), data.slice(0, 10 + 64), `${selector("FloorPriceAboveMaximum(uint256)")}${"00".repeat(32)}`, "0xdeadbeef", "0x", null, new Error("x")]) {
    assert.equal(decodeOxleyRevert(other)?.name, undefined, String(other));
  }
});
test("WalletCapExceeded names the wallet's remaining room, in the quote symbol it is given", () => {
  const cap = (remaining: bigint) => encodeErrorResult({ abi: oxleyRevertAbi, errorName: "WalletCapExceeded", args: [addr(9), 60_000_000_000n, remaining] });
  // The opening ceiling is ceil(30,303,030,303 / 10); the wording is the remaining allowance the revert itself carries.
  assert.equal(decodeOxleyRevert(cap(3_030_303_031n))!.message, "You can bid up to 3030.303031 USDC more on this auction");
  assert.equal(decodeOxleyRevert(cap(3_030_303_031n), { quoteSymbol: "Oxy-USDC" })!.message, "You can bid up to 3030.303031 Oxy-USDC more on this auction");
  assert.equal(decodeOxleyRevert(cap(0n))!.message, "This wallet has reached its limit on this auction");
});
