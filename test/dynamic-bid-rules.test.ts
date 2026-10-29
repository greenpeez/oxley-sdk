import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, maxUint128, type Hex } from "viem";
import { acceptedBidFee, affordableBid, alignBidPrice, bidDebit, bidRefusal, bidsRemaining, buildDynamicBid, buildDynamicRebid, decodeBidWitnesses,
  encodeBidWitnesses, liveBids, maximumNewBid, normalizeCheckpoints, walletAllowance, walletCeiling, witnessFor, GEN8_TOKEN_CAP, GEN8_MIN_BID,
  type Gen8Position, type Gen8WalletLimits } from "../src/auctions.js";
import { OxleyError } from "../src/index.js";
import { addr, full, id32 } from "./support/chain.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const position = (bidId: bigint, extra: Partial<Gen8Position> = {}): Gen8Position => ({ bidId, amountUnits: 1n, maxPriceQ96: 1n, exited: false, outbid: false, ...extra });
const limits = (extra: Partial<Gen8WalletLimits> = {}): Gen8WalletLimits => ({ creatorExcluded: false, termsAccepted: true, positions: [], allowance: 500_000_000n,
  balance: 1_000_000_000n, minimumBid: GEN8_MIN_BID, ...extra });

test("the accepted-bid fee is 0.1% rounded down, and the affordable principal is exact at every balance", () => {
  assert.deepEqual([acceptedBidFee(100_000_000n), acceptedBidFee(19_999n), acceptedBidFee(1n), bidDebit(100_000_000n)], [100_000n, 19n, 0n, 100_100_000n]);
  for (const balance of [0n, 1n, 9_999n, 10_009n, 10_010n, 30_000_000n, 1_000_000_000n, 123_456_789_012n, 10n ** 30n]) {
    const principal = affordableBid(balance);
    assert.ok(bidDebit(principal) <= balance, `fits ${balance}`);
    if (principal < maxUint128) assert.ok(bidDebit(principal + 1n) > balance, `is largest for ${balance}`);
  }
  assert.equal(affordableBid(10n ** 60n), maxUint128);
  assert.throws(() => affordableBid(-1n), code("INVALID_AMOUNT"));
});
test("a wallet's ceiling and allowance follow the hook's formulas", () => {
  // Minimum gross raise 50,505.050505 USDC: a tenth, rounded up, until others commit more than nine times the ceiling.
  assert.equal(walletCeiling(50_505_050_505n, 0n), 5_050_505_051n);
  assert.equal(walletCeiling(50_505_050_505n, 45_454_545_454n), 5_050_505_051n);
  assert.equal(walletCeiling(50_505_050_505n, 45_454_545_459n), 5_050_505_051n);
  assert.equal(walletCeiling(50_505_050_505n, 100_000_000_000n), 11_111_111_111n);
  assert.equal(walletCeiling(10n, 0n), 1n);
  const Q96 = 1n << 96n;
  assert.equal(walletAllowance({ ceiling: 1000n, committed: 400n, tokensHeld: 0n, clearingPriceQ96: Q96 }), 600n);
  assert.equal(walletAllowance({ ceiling: 1000n, committed: 1000n, tokensHeld: 0n, clearingPriceQ96: Q96 }), 0n);
  assert.equal(walletAllowance({ ceiling: 1000n, committed: 1200n, tokensHeld: 0n, clearingPriceQ96: Q96 }), 0n);
  // The 30M-token cap binds when the wallet already holds almost all of it: 5 tokens left at twice the unit price.
  assert.equal(walletAllowance({ ceiling: 10n ** 30n, committed: 0n, tokensHeld: GEN8_TOKEN_CAP - 5n * 10n ** 18n, clearingPriceQ96: 2n * Q96 }), 10n * 10n ** 18n);
  assert.equal(walletAllowance({ ceiling: 10n ** 30n, committed: 0n, tokensHeld: GEN8_TOKEN_CAP + 1n, clearingPriceQ96: Q96 }), 0n);
});
test("live slots and the lifetime cap count exited and outbid bids as the hook does", () => {
  const live = [position(0n), position(1n)], outbid = position(2n, { outbid: true }), exited = position(3n, { exited: true });
  assert.deepEqual([liveBids([...live, outbid, exited]), bidsRemaining([...live, outbid, exited])], [2, 1]);
  assert.equal(bidsRemaining([]), 3);
  assert.equal(bidsRemaining([position(0n), position(1n), position(2n)]), 0);
  assert.equal(bidsRemaining(Array.from({ length: 12 }, (_, i) => position(BigInt(i), { exited: true }))), 0);
  assert.equal(bidsRemaining(Array.from({ length: 11 }, (_, i) => position(BigInt(i), { exited: true }))), 1);
});
test("refusals are decided in the hook's order and the cap applies to new bids only", () => {
  assert.equal(bidRefusal(limits(), 20_000_000n), undefined);
  assert.equal(bidRefusal(limits(), 500_000_000n), undefined);
  assert.equal(bidRefusal(limits(), 500_000_001n), "cap");
  // 100 USDC covers a principal of 99.9001 plus its 0.1% fee exactly: one more base unit no longer fits.
  assert.equal(maximumNewBid(limits({ balance: 100_000_000n })), 99_900_100n);
  assert.equal(bidRefusal(limits({ balance: 100_000_000n }), 99_900_100n), undefined);
  assert.equal(bidRefusal(limits({ balance: 100_000_000n }), 99_900_101n), "cap");
  assert.equal(bidRefusal(limits(), 19_999_999n), "minimum");
  assert.equal(bidRefusal(limits({ positions: [position(0n), position(1n), position(2n)] }), 30_000_000n), "bids");
  assert.equal(bidRefusal(limits({ positions: [position(0n), position(1n), position(2n)] }), 30_000_000n, true), undefined);
  assert.equal(bidRefusal(limits({ termsAccepted: false }), 30_000_000n), "terms");
  assert.equal(bidRefusal(limits({ creatorExcluded: true, termsAccepted: false }), 1n), "creator");
  assert.equal(bidRefusal(limits(), 900_000_000n, true), undefined, "a rebid frees its own funds, which the hook accounts for on chain");
});
test("prices align down to the tick and must clear the floor, the clearing price and the CCA ceiling", () => {
  const auction = { floorPriceQ96: 1000n, tickSpacingQ96: 100n, maxPriceQ96: 10_000n, clearingPriceQ96: 1500n };
  assert.equal(alignBidPrice(2099n, auction), 2000n);
  assert.equal(alignBidPrice(10_000n, auction), 10_000n);
  for (const requested of [1599n, 1500n, 10_100n, 0n, -5n]) assert.throws(() => alignBidPrice(requested, auction), code("INVALID_BID_PRICE"), String(requested));
  assert.throws(() => alignBidPrice(2000n, { ...auction, tickSpacingQ96: 0n }), code("INVALID_BID_PRICE"));
});
test("witnesses name stored checkpoints: live bids use the latest, outbid bids their exact crossing links", () => {
  const history = [{ block: 10n, clearingPrice: 100n }, { block: 20n, clearingPrice: 150n }, { block: 30n, clearingPrice: 200n }, { block: 30n, clearingPrice: 200n }];
  const latest = { block: 30n, clearingPrice: 200n };
  assert.deepEqual(witnessFor({ id: 1n, maxPrice: 250n, startBlock: 25n }, history, latest), { lastFull: 30n, outbid: 0n });
  assert.deepEqual(witnessFor({ id: 0n, maxPrice: 150n, startBlock: 10n }, history, latest), { lastFull: 10n, outbid: 30n });
  assert.deepEqual(witnessFor({ id: 2n, maxPrice: 200n, startBlock: 10n }, history, latest), { lastFull: 20n, outbid: 0n }); // marginal
  assert.throws(() => witnessFor({ id: 3n, maxPrice: 50n, startBlock: 10n }, history, latest), code("WITNESS_UNAVAILABLE"));
  assert.throws(() => witnessFor({ id: 4n, maxPrice: 150n, startBlock: 31n }, history, latest), code("WITNESS_UNAVAILABLE"));
  assert.deepEqual(normalizeCheckpoints([{ block: 3n, clearingPrice: 9n }, { block: 1n, clearingPrice: 5n }, { block: 3n, clearingPrice: 9n }]),
    [{ block: 1n, clearingPrice: 5n }, { block: 3n, clearingPrice: 9n }]);
  assert.throws(() => normalizeCheckpoints([{ block: 1n, clearingPrice: 9n }, { block: 2n, clearingPrice: 8n }]), code("WITNESS_UNAVAILABLE"));
});
test("witness data is exactly abi.encode(BidWitness[]) with at most twelve uint64 pairs", () => {
  const witnesses = [{ lastFull: 10n, outbid: 30n }, { lastFull: 30n, outbid: 0n }];
  const data = encodeBidWitnesses(witnesses);
  assert.deepEqual(decodeBidWitnesses(data), witnesses);
  assert.equal(encodeBidWitnesses([]), `0x${"20".padStart(64, "0")}${"0".repeat(64)}`);
  assert.equal(decodeBidWitnesses(encodeBidWitnesses(Array.from({ length: 12 }, () => witnesses[0]!))).length, 12);
  assert.throws(() => encodeBidWitnesses(Array.from({ length: 13 }, () => witnesses[0]!)), code("INVALID_HINT"));
  for (const bad of [{ lastFull: 1n << 64n, outbid: 0n }, { lastFull: -1n, outbid: 0n }, { lastFull: 1, outbid: 0n }]) {
    assert.throws(() => encodeBidWitnesses([bad as never]), OxleyError);
  }
  assert.throws(() => decodeBidWitnesses(`${data}00` as Hex), OxleyError);
});
test("bid and rebid calldata encode the compiled router ABI and validate every field", () => {
  const abi = full("ElysiumCcaBidRouterGen8"), witnesses = [{ lastFull: 10n, outbid: 30n }];
  const input = { dealId: id32(5), maxPriceQ96: 2000n, previousTick: 1500n, deadline: 99n, entered: 100_000_000n, witnesses, chainId: 99801, bidRouter: addr(26) };
  const bid = buildDynamicBid(input);
  assert.deepEqual([bid.to, bid.value, bid.chainId], [addr(26), 0n, 99801]);
  assert.deepEqual(decodeFunctionData({ abi, data: bid.data }).args, [id32(5), 2000n, 100_000_000n, 1500n, 99n, encodeBidWitnesses(witnesses)]);
  const rebid = buildDynamicRebid({ ...input, oldBidId: 4n, exit: { lastFull: 20n, outbid: 0n } });
  assert.deepEqual(decodeFunctionData({ abi, data: rebid.data }).args, [id32(5), 4n, { lastFull: 20n, outbid: 0n }, 2000n, 100_000_000n, 1500n, 99n, encodeBidWitnesses(witnesses)]);
  assert.doesNotThrow(() => buildDynamicBid({ ...input, entered: (1n << 128n) - 1n }));
  const bad: [object, string][] = [[{ entered: 19_999_999n }, "BID_TOO_LOW"], [{ entered: 1n << 128n }, "BID_TOO_LOW"], [{ maxPriceQ96: 0n }, "INVALID_AMOUNT"],
    [{ previousTick: -1n }, "INVALID_AMOUNT"], [{ deadline: 0n }, "INVALID_AMOUNT"], [{ dealId: "0x00" }, "INVALID_HASH"], [{ chainId: 0 }, "INVALID_CHAIN"],
    [{ bidRouter: addr(0) }, "INVALID_ADDRESS"], [{ witnesses: Array.from({ length: 13 }, () => witnesses[0]!) }, "INVALID_HINT"]];
  for (const [patch, expected] of bad) assert.throws(() => buildDynamicBid({ ...input, ...patch } as typeof input), code(expected), expected);
  assert.throws(() => buildDynamicRebid({ ...input, oldBidId: -1n, exit: witnesses[0]! }), code("INVALID_AMOUNT"));
  assert.throws(() => buildDynamicRebid({ ...input, oldBidId: 1n, exit: { lastFull: 1n << 64n, outbid: 0n } }), code("INVALID_HINT"));
});
