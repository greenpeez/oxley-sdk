import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import { createOxleyAuctionClient, decodeBidWitnesses, encodeBidWitnesses, parseAuctionDeployment, gen8BidHookAbi, GEN8_BID_RULES } from "../src/auctions.js";
import { OxleyError, tokenAbi } from "../src/index.js";
import { parseLaunchDeployment } from "../src/launch.js";
import { addr, full, manifest } from "./support/chain.js";
import { auction, createAuctionWorld, dealId, owner, ROUTER, HOOK, type AuctionWorld, type StoredBid } from "./support/auction.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const request = { dealId, caller: owner, entered: 100_000_000n, maxPriceQ96: 2000n };
const bid = (id: bigint, maxPrice: bigint, startBlock: bigint, extra: Partial<StoredBid> = {}): StoredBid =>
  ({ id, owner, maxPrice, startBlock, amountQ96: 50_000_000n << 96n, exitedBlock: 0n, ...extra });
/** Bid 0 is outbid (price 150 < clearing 200) and bid 1 is live; the checkpoint history crosses bid 0's price at blocks 10 and 30. */
function withBids(chain: AuctionWorld, ...stored: StoredBid[]) {
  chain.world.ids = stored.map(item => item.id);
  stored.forEach(item => chain.world.bids.set(item.id, item));
  chain.world.logs = [10n, 20n, 30n].map(block => ({ args: { blockNumber: block, clearingPriceQ96: chain.world.checkpoints.get(block)!.clearingPrice, cumulativeMps: 0 } }));
}

test("a fresh wallet's limits come from the hook, bounded by the balance after the 0.1% fee", async () => {
  const chain = createAuctionWorld();
  const limits = await chain.client().getDynamicBidLimits({ dealId, owner });
  assert.deepEqual([limits.committed, limits.ceiling, limits.allowance, limits.minimumBid], [0n, 5_050_505_051n, 5_050_505_051n, 20_000_000n]);
  assert.deepEqual([limits.liveBids, limits.bidsLeft, limits.positions.length, limits.minimumRaiseMet, limits.termsAccepted, limits.creatorExcluded], [0, 3, 0, false, true, false]);
  assert.equal(limits.clearingPriceQ96, 200n); assert.equal(limits.maximumBid, 999_000_999n); // largest principal whose fee still fits 1000 USDC
  assert.deepEqual(limits.rules, GEN8_BID_RULES); assert.equal(limits.blockNumber, 100n);
  chain.world.balance = 30_000_000n;
  assert.equal((await chain.client().getDynamicBidLimits({ dealId, owner })).maximumBid, 29_970_030n); // principal + floor(0.1%) == the balance
});
test("stored bids are classified, slots counted and one verified witness is produced per bid", async () => {
  const chain = createAuctionWorld();
  withBids(chain, bid(0n, 150n, 10n), bid(1n, 2500n, 25n));
  const limits = await chain.client().getDynamicBidLimits({ dealId, owner });
  assert.deepEqual(limits.positions.map(p => [p.bidId, p.outbid, p.exited, p.amountUnits]), [[0n, true, false, 50_000_000n], [1n, false, false, 50_000_000n]]);
  assert.deepEqual([limits.liveBids, limits.bidsLeft], [1, 2]);
  const preview = chain.state.simulations.find(call => call.to === HOOK && decodeFunctionData({ abi: gen8BidHookAbi, data: call.data }).functionName === "preview");
  assert.deepEqual(decodeFunctionData({ abi: gen8BidHookAbi, data: preview!.data }).args,
    [auction, owner, [{ lastFull: 10n, outbid: 30n }, { lastFull: 30n, outbid: 0n }]]);
  // An exited or marginal bid keeps its slot accounting; the creator has no slots at all.
  withBids(chain, bid(0n, 150n, 10n, { exitedBlock: 40n }));
  assert.deepEqual((await chain.client().getDynamicBidLimits({ dealId, owner })).positions.map(p => p.exited), [true]);
  chain.world.creatorExcluded = true;
  const creator = await chain.client().getDynamicBidLimits({ dealId, owner });
  assert.deepEqual([creator.creatorExcluded, creator.bidsLeft], [true, 0]);
});
test("a stale or inconsistent checkpoint history makes the witnesses unavailable instead of guessing", async () => {
  const chain = createAuctionWorld();
  withBids(chain, bid(0n, 150n, 10n));
  chain.world.logs = [];
  await assert.rejects(chain.client().getDynamicBidLimits({ dealId, owner }), code("WITNESS_UNAVAILABLE"));
  withBids(chain, bid(0n, 150n, 10n));
  chain.world.checkpoints.set(20n, { clearingPrice: 150n, prev: 10n, next: 30n });
  chain.world.checkpoints.get(30n)!.prev = 0n; // outbid.prev must name a checkpoint at or below the bid's price
  await assert.rejects(chain.client().getDynamicBidLimits({ dealId, owner }), code("WITNESS_UNAVAILABLE"));
  withBids(chain, ...Array.from({ length: 13 }, (_, i) => bid(BigInt(i), 2500n, 25n)));
  await assert.rejects(chain.client().getDynamicBidLimits({ dealId, owner }), code("WITNESS_UNAVAILABLE"));
});
test("a first bid carries empty witnesses, a derived previous tick, exact approvals and the accepted-bid fee", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000_000_000 });
  const chain = createAuctionWorld();
  const prepared = await chain.client().prepareDynamicBid(request);
  assert.deepEqual([prepared.kind, prepared.principal, prepared.fee, prepared.debit, prepared.simulated], ["bid", 100_000_000n, 100_000n, 100_100_000n, false]);
  assert.equal(prepared.deadline, 2_000_000_120n); assert.equal(prepared.previousTick, 1500n);
  const decoded = decodeFunctionData({ abi: full("ElysiumCcaBidRouterGen8"), data: prepared.transaction.data });
  assert.equal(prepared.transaction.to, ROUTER);
  assert.deepEqual([decoded.functionName, decoded.args], ["submitBid", [dealId, 2000n, 100_000_000n, 1500n, 2_000_000_120n, encodeBidWitnesses([])]]);
  assert.deepEqual(prepared.approvals.map(tx => [tx.to, decodeFunctionData({ abi: tokenAbi, data: tx.data }).args]), [[addr(3), [ROUTER, 100_100_000n]]]);
  // An initialized price level needs no insertion point; a new level between ticks needs the tick below it.
  assert.equal((await chain.client().prepareDynamicBid({ ...request, maxPriceQ96: 2500n })).previousTick, 1000n);
  assert.equal((await chain.client().prepareDynamicBid({ ...request, maxPriceQ96: 1200n })).previousTick, 1000n);
  assert.equal((await chain.client().prepareDynamicBid({ ...request, previousTick: 7n })).previousTick, 7n);
});
test("a wallet with stored bids sends one witness per bid, and simulation needs the approval first", async () => {
  const chain = createAuctionWorld();
  withBids(chain, bid(0n, 150n, 10n), bid(1n, 2500n, 25n));
  const sdk = chain.client();
  await assert.rejects(sdk.prepareDynamicBid({ ...request, simulate: true, deadline: 5000n }), code("APPROVAL_REQUIRED"));
  chain.world.allowance = 100_100_000n;
  const prepared = await sdk.prepareDynamicBid({ ...request, simulate: true, deadline: 5000n });
  const [, , , , , data] = decodeFunctionData({ abi: full("ElysiumCcaBidRouterGen8"), data: prepared.transaction.data }).args as [unknown, unknown, unknown, unknown, unknown, `0x${string}`];
  assert.deepEqual(decodeBidWitnesses(data), [{ lastFull: 10n, outbid: 30n }, { lastFull: 30n, outbid: 0n }]);
  assert.deepEqual([prepared.approvals.length, prepared.simulated, prepared.deadline], [0, true, 5000n]);
  assert.deepEqual(chain.state.simulations.at(-1) && [chain.state.simulations.at(-1)!.to, chain.state.simulations.at(-1)!.account], [ROUTER, owner]);
});
test("everything the hook, router or CCA would refuse is refused before simulation, with a structured reason", async () => {
  const chain = createAuctionWorld(), sdk = chain.client();
  const rejects = (input: object, expected: string) => assert.rejects(sdk.prepareDynamicBid({ ...request, ...input }), code(expected), JSON.stringify(input, (_, v) => typeof v === "bigint" ? String(v) : v));
  await rejects({ entered: 19_999_999n }, "BID_TOO_LOW");
  await rejects({ entered: 0n }, "INVALID_AMOUNT");
  await rejects({ deadline: 1000n }, "EXPIRED_DEADLINE");
  await rejects({ maxPriceQ96: 2050n }, "INVALID_BID_PRICE"); // off tick
  await rejects({ maxPriceQ96: 200n }, "INVALID_BID_PRICE"); // not above the clearing price
  await rejects({ maxPriceQ96: 1_000_100n }, "INVALID_BID_PRICE"); // above the CCA ceiling
  await rejects({ entered: 6_000_000_000n }, "WALLET_CAP_EXCEEDED");
  chain.world.balance = 50_000_000n;
  await assert.rejects(sdk.prepareDynamicBid({ ...request, entered: 60_000_000n }), (error: unknown) => code("WALLET_CAP_EXCEEDED")(error) && (error as OxleyError).details?.maximumBid === 49_950_050n);
  chain.world.balance = 1_000_000_000n;
  chain.world.termsAccepted = false; await rejects({}, "TERMS_NOT_ACCEPTED"); chain.world.termsAccepted = true;
  chain.world.creatorExcluded = true; await rejects({}, "CREATOR_BID_NOT_ALLOWED"); chain.world.creatorExcluded = false;
  chain.world.block = 10_000n; await rejects({}, "AUCTION_NOT_OPEN"); chain.world.block = 150n;
  chain.world.open = false; await rejects({}, "AUCTION_NOT_OPEN"); chain.world.open = true;
  chain.world.quoteFee = 1n; await rejects({}, "INVALID_BID_QUOTE"); chain.world.quoteFee = undefined;
  withBids(chain, bid(1n, 2500n, 25n), bid(2n, 2500n, 26n), bid(3n, 2500n, 27n));
  await rejects({}, "WALLET_BID_LIMIT");
});
test("a rebid exits one outbid bid with its own witness and is available only after the minimum raise is met", async () => {
  const chain = createAuctionWorld();
  withBids(chain, bid(0n, 150n, 10n), bid(1n, 2500n, 25n));
  const sdk = chain.client(), rebid = { ...request, oldBidId: 0n, deadline: 5000n };
  await assert.rejects(sdk.prepareDynamicRebid(rebid), code("REBID_NOT_AVAILABLE")); // minimum raise not met yet
  chain.world.minimumRaiseMet = true;
  const prepared = await sdk.prepareDynamicRebid(rebid);
  const decoded = decodeFunctionData({ abi: full("ElysiumCcaBidRouterGen8"), data: prepared.transaction.data });
  assert.equal(prepared.kind, "rebid"); assert.deepEqual(prepared.exit, { lastFull: 10n, outbid: 30n });
  assert.deepEqual([decoded.functionName, decoded.args?.slice(0, 3)], ["rebid", [dealId, 0n, { lastFull: 10n, outbid: 30n }]]);
  await assert.rejects(sdk.prepareDynamicRebid({ ...rebid, oldBidId: 1n }), code("REBID_NOT_AVAILABLE")); // still live
  await assert.rejects(sdk.prepareDynamicRebid({ ...rebid, oldBidId: 9n }), code("REBID_NOT_AVAILABLE")); // not this wallet's
  await assert.rejects(sdk.prepareDynamicRebid({ ...rebid, maxPriceQ96: 200n }), code("INVALID_BID_PRICE"));
  await assert.rejects(sdk.prepareDynamicRebid({ ...rebid, oldBidId: -1n }), code("INVALID_AMOUNT"));
  withBids(chain, bid(0n, 150n, 10n, { exitedBlock: 40n }));
  await assert.rejects(sdk.prepareDynamicRebid(rebid), code("REBID_NOT_AVAILABLE")); // already exited
});
test("Dynamic Bids exist only on Gen8 and the generic bid path refuses a Gen8 deployment", async () => {
  const chain = createAuctionWorld();
  const flat = createOxleyAuctionClient({ publicClient: chain.rpc, deployment: manifest("flat-fee", 0) });
  await assert.rejects(flat.prepareDynamicBid(request), code("GEN8_REQUIRED"));
  await assert.rejects(flat.getDynamicBidLimits({ dealId, owner }), code("GEN8_REQUIRED"));
  await assert.rejects(chain.client().prepareBid({ ...request, previousTick: 1n, deadline: 5000n }), code("DYNAMIC_BID_REQUIRED"));
});
test("a Gen8 auction deployment pins the hook, helper, terms registry and exact rules; Gen3 and launches are refused", async () => {
  const gen8 = manifest("gen8", 20), bindings: Record<string, unknown> = { ...gen8.auctionBindings };
  delete bindings.bidHook;
  assert.equal(parseAuctionDeployment(gen8).auctionBindings.bidHook?.address, addr(28));
  assert.throws(() => parseAuctionDeployment({ ...gen8, auctionBindings: bindings }), code("AUCTION_BINDINGS_REQUIRED"));
  assert.throws(() => parseAuctionDeployment({ ...gen8, bidRules: { ...GEN8_BID_RULES, minBid: "10000000" } }), code("INVALID_BID_RULES"));
  assert.throws(() => parseAuctionDeployment({ ...gen8, bidRules: undefined }), code("INVALID_BID_RULES"));
  assert.throws(() => parseAuctionDeployment({ ...gen8, auctionBindings: { ...gen8.auctionBindings, bidHook: gen8.auctionBindings.adapter } }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseAuctionDeployment(manifest("gen3", 10)), code("UNSUPPORTED_GENERATION"));
  assert.throws(() => parseAuctionDeployment({ ...manifest("flat-fee", 0), bidRules: GEN8_BID_RULES }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseLaunchDeployment({ ...gen8, launchBindings: {} }), code("UNSUPPORTED_GENERATION"));
});
test("verification rejects a hook, helper or registry that differs from the pins, and compiled rules the SDK does not mirror", async () => {
  const mutate = [
    (c: AuctionWorld) => { c.world.hookTerms = addr(99); },
    (c: AuctionWorld) => { c.world.hookRulesMinimum = 10_000_000n; },
    (c: AuctionWorld) => { c.state.codes.set(addr(29), "0x"); },
    (c: AuctionWorld) => { c.state.codes.set(addr(28), "0x"); },
    (c: AuctionWorld) => { c.state.codes.set(addr(25), "0x"); },
  ];
  assert.equal((await createAuctionWorld().client().verifyDeployment()).blockNumber, 100n);
  for (const change of mutate) {
    const chain = createAuctionWorld(); change(chain);
    await assert.rejects(chain.client().verifyDeployment(), (error: unknown) => error instanceof OxleyError && /MISMATCH/.test(error.code));
  }
});
