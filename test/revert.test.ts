import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseError, ContractFunctionRevertedError, RawContractError, encodeErrorResult, type Hex } from "viem";
import { decodeOxleyRevert } from "../src/index.js";
import { addr, full, id32 } from "./support/chain.js";

const owner = addr(9), id = id32(0xabc);

test("decodeOxleyRevert names every bid, gate and trade rule error from raw data, viem errors and the CCA hook wrapper", () => {
  const hook = full("bid-hook"), curve = full("curve"), router = full("bid-router");
  const cap = encodeErrorResult({ abi: hook, errorName: "WalletCapExceeded", args: [owner, 60_000_000_000n, 3_030_303_031n] });
  const cases: [Hex, string, unknown[], RegExp][] = [
    [cap, "WalletCapExceeded", [owner, 60_000_000_000n, 3_030_303_031n], /^You can bid up to 3030\.303031 USDC more on this auction$/],
    [encodeErrorResult({ abi: hook, errorName: "CreatorBidNotAllowed", args: [owner] }), "CreatorBidNotAllowed", [owner], /^Creators can't bid on their own auction$/],
    [encodeErrorResult({ abi: hook, errorName: "WalletBidLimitReached", args: [owner, 3n] }), "WalletBidLimitReached", [owner, 3n], /limit of 3 live bids/],
    [encodeErrorResult({ abi: hook, errorName: "WalletBidLimitReached", args: [owner, 12n] }), "WalletBidLimitReached", [owner, 12n], /limit of 12 total bids/],
    [encodeErrorResult({ abi: hook, errorName: "BidAmountTooLow" }), "BidAmountTooLow", [], /Minimum bid is 20 Oxy-USDC/],
    [encodeErrorResult({ abi: hook, errorName: "PriceLevelLimit", args: [5n] }), "PriceLevelLimit", [5n], /Too many price levels/],
    [encodeErrorResult({ abi: hook, errorName: "BidPriceTooHigh", args: [9n, 8n] }), "BidPriceTooHigh", [9n, 8n], /above the auction's maximum/],
    [encodeErrorResult({ abi: hook, errorName: "InvalidWitness" }), "InvalidWitness", [], /checkpoint hints .* are stale/],
    [encodeErrorResult({ abi: router, errorName: "BidExpired" }), "BidExpired", [], /deadline has passed/],
    [encodeErrorResult({ abi: router, errorName: "NotBidOwner" }), "NotBidOwner", [], /Only the bid's owner/],
    [encodeErrorResult({ abi: router, errorName: "BidNotOutbid" }), "BidNotOutbid", [], /Only an outbid bid/],
    [encodeErrorResult({ abi: router, errorName: "RebidPriceTooLow", args: [5n, 6n] }), "RebidPriceTooLow", [5n, 6n], /above the current clearing price/],
    [encodeErrorResult({ abi: curve, errorName: "TradingNotOpen", args: [id, 1_790_000_000n] }), "TradingNotOpen",
      [id, 1_790_000_000n], /^Trading opens after all bids are delivered \(by 2026-09-21T14:13:20Z at the latest\)$/],
    [encodeErrorResult({ abi: curve, errorName: "BuysPaused" }), "BuysPaused", [], /Buying is paused/],
    [encodeErrorResult({ abi: curve, errorName: "MinimumNotMet" }), "MinimumNotMet", [], /minimum/],
    [encodeErrorResult({ abi: curve, errorName: "DeadlineExpired" }), "DeadlineExpired", [], /deadline has passed/],
    [encodeErrorResult({ abi: curve, errorName: "QuoteDust" }), "QuoteDust", [], /different amount/],
    [encodeErrorResult({ abi: curve, errorName: "CapitalShortfall" }), "CapitalShortfall", [], /cannot fill/],
    [encodeErrorResult({ abi: full("terms-registry"), errorName: "TermsNotAccepted", args: [owner, 2n, 1n] }), "TermsNotAccepted", [owner, 2n, 1n], /accept the current Oxley terms/],
  ];
  for (const [data, name, args, message] of cases) {
    for (const wrapped of [data, new BaseError("Execution reverted", { cause: new RawContractError({ data }) }), { error: { code: 3, data } }]) {
      const decoded = decodeOxleyRevert(wrapped);
      assert.ok(decoded, name); assert.equal(decoded.name, name); assert.deepEqual(decoded.args, args); assert.match(decoded.message, message);
      assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.args), name);
    }
  }
  const viemError = new ContractFunctionRevertedError({ abi: hook, data: cap, functionName: "checkBid" });
  assert.equal(decodeOxleyRevert(viemError)?.name, "WalletCapExceeded");
  const wrappedByCca = encodeErrorResult({ abi: full("cca-auction"), errorName: "ValidationHookCallFailed", args: [cap] });
  assert.equal(decodeOxleyRevert(wrappedByCca)?.name, "WalletCapExceeded");
  assert.match(decodeOxleyRevert(cap, { quoteSymbol: "Oxy-USDC" })?.message ?? "", /Oxy-USDC/);
  const stringRevert = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], errorName: "Error", args: ["no"] });
  for (const other of ["0xdeadbeef", "0x", stringRevert, new Error("network"), null, 42, { data: { data: "nothex" } }]) {
    assert.equal(decodeOxleyRevert(other), null);
  }
});
