import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, type Hex } from "viem";
import { createOxleyMarkets, deploymentGeneration, GEN9_MAX_FLOOR_PRICE_WAD, OxleyError, parseDeployment, testnetDeployments, tokenAbi } from "../src/index.js";
import { createOxleyAuctionClient, GEN8_BID_RULES, parseAuctionDeployment } from "../src/auctions.js";
import { parseLaunchDeployment } from "../src/launch.js";
import { deploymentAddresses } from "../src/deployment-addresses.js";
import { addr, BASES, full, gen9Fixture, manifest, mockVerifiable, read } from "./support/chain.js";
import { auction, createAuctionWorld, dealId, owner, type AuctionWorld, type StoredBid } from "./support/auction.js";
import { ALL_GENERATIONS, createWorld } from "./support/world.js";
import { scripts } from "./support/manifests.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const gen8File = () => JSON.parse(read("deployments/elysium-testnet-gen8.json")) as ReturnType<typeof manifest>;
type Roles = Record<string, { address: string; runtimeCodeHash: string }>;
/** Every contract the manifest pins, by role; the controller's pin is its address plus the runtime hash held under `auctionBindings`. */
const pinsOf = (m: ReturnType<typeof manifest>): Roles => {
  const b = m.auctionBindings as unknown as Record<string, { address: string; runtimeCodeHash: string }> & { controllerRuntimeCodeHash: string };
  return { curve: m.curve, registry: m.registry, controller: { address: m.auctionController, runtimeCodeHash: b.controllerRuntimeCodeHash }, termsRegistry: m.termsRegistry!,
    bidRouter: b.bidRouter!, adapter: b.adapter!, bidHook: b.bidHook!, exposureHelper: b.exposureHelper! };
};

test("the Gen9 fixture is a valid Gen9 manifest: its own identity everywhere, Gen8's Oxy-USDC, the Gen8 bid rules", () => {
  const fixture = gen9Fixture(), gen8 = gen8File(), parsed = parseDeployment(fixture);
  assert.equal(deploymentGeneration(parsed), "gen9"); assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.termsRegistry));
  assert.match(parsed.releaseId, /^elysium-auctions-gen9-/); assert.notEqual(parsed.releaseId, gen8.releaseId);
  assert.notEqual(parsed.status, "live", "a fixture must never read as a live release");
  assert.doesNotThrow(() => scripts.validateManifest(scripts.manifestFor("gen9"), fixture));
  assert.deepEqual([parsed.chainId, parsed.network, parsed.quoteToken], [gen8.chainId, gen8.network, gen8.quoteToken]);
  const [mine, theirs] = [pinsOf(fixture), pinsOf(gen8)];
  assert.deepEqual(Object.keys(mine), Object.keys(theirs));
  for (const role of Object.keys(mine)) {
    assert.notEqual(mine[role]!.address, theirs[role]!.address, role); assert.notEqual(mine[role]!.runtimeCodeHash, theirs[role]!.runtimeCodeHash, role);
  }
  // Only the reused Oxy-USDC token is common to the two graphs; the eight redeployed roles plus the token are nine distinct addresses.
  const [fixtureAddresses, gen8Addresses] = [deploymentAddresses(fixture), deploymentAddresses(gen8)];
  assert.deepEqual(fixtureAddresses.filter(item => gen8Addresses.includes(item)), [gen8.quoteToken.address]);
  assert.equal(fixtureAddresses.length, 9); assert.deepEqual(fixture.bidRules, GEN8_BID_RULES);
});
test("a Gen9 auction deployment takes the Gen8 rules: all pins, the exact bid rules, and no launches", () => {
  const gen9 = gen9Fixture(), bindings: Record<string, unknown> = { ...gen9.auctionBindings };
  delete bindings.bidHook;
  const parsed = parseAuctionDeployment(gen9);
  assert.equal(parsed.auctionBindings.bidHook?.address, (gen9.auctionBindings as { bidHook: { address: string } }).bidHook.address);
  assert.ok(Object.isFrozen(parsed.auctionBindings.bidHook) && Object.isFrozen(parsed.bidRules));
  assert.throws(() => parseAuctionDeployment({ ...gen9, auctionBindings: bindings }), code("AUCTION_BINDINGS_REQUIRED"));
  assert.throws(() => parseAuctionDeployment({ ...gen9, bidRules: { ...GEN8_BID_RULES, minBid: "10000000" } }), code("INVALID_BID_RULES"));
  assert.throws(() => parseAuctionDeployment({ ...gen9, bidRules: undefined }), code("INVALID_BID_RULES"));
  assert.throws(() => parseAuctionDeployment({ ...gen9, termsRegistry: undefined }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseAuctionDeployment({ ...gen9, auctionBindings: { ...gen9.auctionBindings, bidHook: gen9.auctionBindings.adapter } }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseAuctionDeployment({ ...manifest("flat-fee", 0), auctionBindings: { ...manifest("flat-fee", 0).auctionBindings, bidHook: gen9.curve } }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseLaunchDeployment({ ...gen9, launchBindings: {} }), (error: unknown) => code("UNSUPPORTED_GENERATION")(error) && /Gen8 or Gen9 launches/.test((error as Error).message));
});

const request = { dealId, caller: owner, entered: 100_000_000n, maxPriceQ96: 2000n, deadline: 5000n };
const stored = (id: bigint, maxPrice: bigint, startBlock: bigint): StoredBid => ({ id, owner, maxPrice, startBlock, amountQ96: 50_000_000n << 96n, exitedBlock: 0n });
function withBids(chain: AuctionWorld, ...bids: StoredBid[]) {
  chain.world.ids = bids.map(item => item.id); bids.forEach(item => chain.world.bids.set(item.id, item));
  chain.world.logs = [10n, 20n, 30n].map(block => ({ args: { blockNumber: block, clearingPriceQ96: chain.world.checkpoints.get(block)!.clearingPrice, cumulativeMps: 0 } }));
}
/** The Gen8 world and a Gen9 world built from the fixture's own addresses, with the floor cap answered only by the latter. */
const worlds = () => ({ gen8: createAuctionWorld(), gen9: createAuctionWorld(mockVerifiable(gen9Fixture()), GEN9_MAX_FLOOR_PRICE_WAD) });

test("Dynamic Bids on the Gen9 fixture give the Gen8 limits and calldata; only the pinned router differs", async () => {
  const { gen8, gen9 } = worlds();
  assert.deepEqual(await gen9.client().getDynamicBidLimits({ dealId, owner }), await gen8.client().getDynamicBidLimits({ dealId, owner }));
  withBids(gen8, stored(0n, 150n, 10n), stored(1n, 2500n, 25n)); withBids(gen9, stored(0n, 150n, 10n), stored(1n, 2500n, 25n));
  const [bid8, bid9] = [await gen8.client().prepareDynamicBid(request), await gen9.client().prepareDynamicBid(request)];
  assert.equal(bid9.transaction.data, bid8.transaction.data); assert.deepEqual([bid9.principal, bid9.fee, bid9.debit, bid9.previousTick], [bid8.principal, bid8.fee, bid8.debit, bid8.previousTick]);
  assert.equal(bid9.transaction.to, gen9.roles.router); assert.notEqual(bid9.transaction.to, bid8.transaction.to);
  const decoded = decodeFunctionData({ abi: full("ElysiumCcaBidRouterGen8"), data: bid9.transaction.data });
  assert.equal(decoded.functionName, "submitBid"); assert.equal(decoded.args?.[0], dealId);
  const approval = bid9.approvals[0]!;
  const [spender, amount] = decodeFunctionData({ abi: tokenAbi, data: approval.data }).args as [string, bigint];
  assert.deepEqual([approval.to, spender.toLowerCase(), amount], [gen9.roles.quote, gen9.roles.router, bid9.debit]);
  assert.equal(gen9.roles.quote, gen8File().quoteToken.address, "the bid is paid in the Oxy-USDC that Gen8 also uses");
  // The generic bid path refuses every family member, naming both.
  await assert.rejects(gen9.client().prepareBid({ ...request, previousTick: 1n }), (error: unknown) => code("DYNAMIC_BID_REQUIRED")(error) && /Gen8 or Gen9/.test((error as Error).message));
});
test("a Gen9 rebid exits one outbid bid with its own witness, exactly like Gen8", async () => {
  const { gen8, gen9 } = worlds();
  const rebid = (chain: AuctionWorld) => {
    withBids(chain, stored(0n, 150n, 10n), stored(1n, 2500n, 25n)); chain.world.minimumRaiseMet = true;
    return chain.client().prepareDynamicRebid({ ...request, oldBidId: 0n });
  };
  const [rebid8, rebid9] = [await rebid(gen8), await rebid(gen9)];
  assert.equal(rebid9.transaction.data, rebid8.transaction.data); assert.deepEqual(rebid9.exit, { lastFull: 10n, outbid: 30n });
  assert.equal(decodeFunctionData({ abi: full("ElysiumCcaBidRouterGen8"), data: rebid9.transaction.data }).functionName, "rebid");
  await assert.rejects(gen9.client().prepareDynamicRebid({ ...request, oldBidId: 1n }), code("REBID_NOT_AVAILABLE"));
});
test("a Gen9 wallet's refusals match Gen8's, and the Dynamic Bid paths stay closed outside the family", async () => {
  const refusals = async (chain: AuctionWorld) => {
    const results: string[] = [], attempt = async (patch: object) => chain.client().prepareDynamicBid({ ...request, ...patch }).then(() => "ok", (error: OxleyError) => error.code);
    results.push(await attempt({ entered: 19_999_999n }), await attempt({ maxPriceQ96: 2050n }), await attempt({ entered: 6_000_000_000n }));
    chain.world.termsAccepted = false; results.push(await attempt({})); chain.world.termsAccepted = true;
    chain.world.creatorExcluded = true; results.push(await attempt({}));
    return results;
  };
  const expected = ["BID_TOO_LOW", "INVALID_BID_PRICE", "WALLET_CAP_EXCEEDED", "TERMS_NOT_ACCEPTED", "CREATOR_BID_NOT_ALLOWED"];
  assert.deepEqual(await refusals(worlds().gen9), expected); assert.deepEqual(await refusals(worlds().gen8), expected);
  const flat = createOxleyAuctionClient({ publicClient: worlds().gen9.rpc, deployment: manifest("flat-fee", 0) });
  await assert.rejects(flat.getDynamicBidLimits({ dealId, owner }), (error: unknown) => code("GEN8_REQUIRED")(error) && /Gen8 or Gen9 deployments/.test((error as Error).message));
  await assert.rejects(flat.prepareDynamicBid(request), code("GEN8_REQUIRED"));
});
test("verifying a Gen9 deployment reads the controller's floor cap; verifying Gen8 reads nothing new", async () => {
  const { gen8, gen9 } = worlds();
  assert.equal((await gen9.client().verifyDeployment()).blockNumber, 100n);
  const capReads = gen9.world.reads.filter(call => call.functionName === "MAX_FLOOR_PRICE_WAD");
  assert.deepEqual(capReads.map(call => [call.address, call.blockNumber]), [[gen9.roles.controller, 100n]]);
  // The Gen8 world would throw on that read: it does not model a capped controller.
  assert.equal((await gen8.client().verifyDeployment()).blockNumber, 100n);
  assert.ok(gen8.world.reads.every(call => call.functionName !== "MAX_FLOOR_PRICE_WAD"));
  assert.equal((await gen8.client().getDynamicBidLimits({ dealId, owner })).blockNumber, 100n);
});
test("a Gen9 manifest whose controller is uncapped or capped differently fails closed, so a Gen8 stack cannot pass as Gen9", async () => {
  const fixture = mockVerifiable(gen9Fixture());
  for (const cap of [GEN9_MAX_FLOOR_PRICE_WAD - 1n, GEN9_MAX_FLOOR_PRICE_WAD * 2n, 0n]) {
    await assert.rejects(createAuctionWorld(fixture, cap).client().verifyDeployment(), code("AUCTION_BINDING_MISMATCH"), String(cap));
  }
  await assert.rejects(createAuctionWorld(fixture).client().verifyDeployment(), /MAX_FLOOR_PRICE_WAD/); // no getter: a Gen8 controller
  // The Gen8 manifest relabelled as Gen9 meets the same wall against the Gen8 stack.
  const relabelled = { ...createAuctionWorld().deployment, generation: "gen9" as never, releaseId: "elysium-auctions-gen9-relabelled" };
  await assert.rejects(createAuctionWorld(relabelled).client().verifyDeployment(), /MAX_FLOOR_PRICE_WAD/);
  const mutate: [string, (c: AuctionWorld) => void][] = [
    ["hook terms", c => { c.world.hookTerms = addr(99); }], ["hook rules", c => { c.world.hookRulesMinimum = 10_000_000n; }],
    ["exposure code", c => { c.state.codes.set(c.roles.exposure, "0x"); }], ["hook code", c => { c.state.codes.set(c.roles.hook, "0x"); }],
    ["terms code", c => { c.state.codes.set(c.roles.terms, "0x"); }],
  ];
  for (const [label, change] of mutate) {
    const chain = createAuctionWorld(fixture, GEN9_MAX_FLOOR_PRICE_WAD); change(chain);
    await assert.rejects(chain.client().verifyDeployment(), (error: unknown) => error instanceof OxleyError && /MISMATCH/.test(error.code), label);
  }
});

const manifests = () => ALL_GENERATIONS.map(generation => manifest(generation, BASES[generation]));
function marketsWorld() {
  const chain = createWorld(), sdk = createOxleyMarkets({ publicClient: chain.rpc, deployments: manifests() });
  const trade = (marketId: Hex, coin: string, side: "buy" | "sell") => ({ marketId, caller: addr(8), amountIn: side === "buy" ? 1_000_000n : 10n ** 18n,
    tokenIn: (side === "buy" ? addr(3) : coin) as `0x${string}`, tokenOut: (side === "buy" ? coin : addr(3)) as `0x${string}` });
  return { ...chain, sdk, trade };
}
test("a Gen9 market resolves to the Gen9 curve and reports its own generation, beside Gen8", async () => {
  const { sdk, addMarket } = marketsWorld();
  const [g8, g9] = [addMarket("gen8", 1), addMarket("gen9", 2)];
  const [one, two] = [await sdk.resolveMarket(g8.id), await sdk.resolveMarket(g9.id)];
  assert.deepEqual([one.entry.generation, one.market.generation, one.market.curve], ["gen8", "gen8", addr(BASES.gen8 + 1)]);
  assert.deepEqual([two.entry.generation, two.market.generation, two.market.curve, two.market.coin], ["gen9", "gen9", addr(BASES.gen9 + 1), g9.coin]);
  assert.deepEqual(sdk.generations.map(item => [item.generation, item.releaseId]), ALL_GENERATIONS.map(g => [g, `test-${g}`]));
  assert.notEqual(sdk.client("gen8").deployment.releaseId, sdk.client("gen9").deployment.releaseId);
  assert.equal(sdk.client("test-gen9").deployment.generation, "gen9");
  const both = addMarket(["gen8", "gen9"], 3);
  await assert.rejects(sdk.resolveMarket(both.id), code("AMBIGUOUS_MARKET"));
});
test("Gen9 quotes and swaps take the quote-only Gen8 shapes: no account argument, four-argument sell, terms, gate and surcharge", async () => {
  const { sdk, addMarket, trade, world, state } = marketsWorld();
  const g9 = addMarket("gen9", 2);
  await sdk.resolveMarket(g9.id);
  const resolved = state.calls.length;
  world.surcharge = 90_000_000_000_000_000n; world.buy = { out: 800_000n, fee: 110_000n };
  const buy = await sdk.quote(trade(g9.id, g9.coin, "buy"));
  assert.deepEqual([buy.amountOut, buy.feeAmount, buy.openingSurchargeWad, buy.market.generation], [800_000n, 110_000n, 90_000_000_000_000_000n, "gen9"]);
  await sdk.quote(trade(g9.id, g9.coin, "sell"));
  assert.deepEqual(world.quoteCallers, [], "quote-only views take no account");
  const abi = full("ElysiumCurveGen8");
  const swap = await sdk.prepareSwap({ ...trade(g9.id, g9.coin, "buy"), slippageBps: 100 });
  assert.deepEqual(decodeFunctionData({ abi, data: swap.transaction.data }).args, [g9.id, 1_000_000n, 792_000n, 1300n]);
  assert.equal(swap.transaction.to, addr(BASES.gen9 + 1)); assert.equal(swap.quote.releaseId, "test-gen9");
  const sell = await sdk.prepareSwap({ ...trade(g9.id, g9.coin, "sell"), slippageBps: 100 });
  assert.deepEqual(decodeFunctionData({ abi, data: sell.transaction.data }).args, [g9.id, 10n ** 18n, 891_000n, 1300n]);
  const checked = await sdk.checkSwap(swap);
  assert.deepEqual([checked.termsAccepted, checked.approvals.length], [true, 1]);
  const terms = await sdk.getTermsStatus({ marketId: g9.id, account: addr(8) });
  assert.deepEqual([terms.termsRegistry, terms.enforced], [addr(BASES.gen9 + 5), false]);
  // The Gen2+ trading gate and a paused buy behave as on Gen8.
  world.open = false;
  await assert.rejects(sdk.quote(trade(g9.id, g9.coin, "buy")), code("TRADING_NOT_OPEN"));
  world.open = true; world.paused = true;
  await assert.rejects(sdk.quote(trade(g9.id, g9.coin, "buy")), /BuysPaused/);
  assert.equal((await sdk.quote(trade(g9.id, g9.coin, "sell"))).side, "sell");
  assert.ok(state.calls.slice(resolved).every(call => call.address !== addr(BASES.gen8 + 1)), "a resolved Gen9 market never reads the Gen8 curve");
});
test("a deployment identity picks the Gen9 curve by address and a Gen8 identity never matches a Gen9 market", async () => {
  const { sdk, addMarket, state } = marketsWorld();
  const g9 = addMarket("gen9", 1), g8 = addMarket("gen8", 2), [pins8, pins9] = [manifests()[2]!, manifests()[3]!];
  const identityOf = (pins: ReturnType<typeof manifest>) => ({ chainId: 31337, curve: pins.curve, quote: pins.quoteToken,
    controller: { address: pins.auctionController, runtimeCodeHash: pins.auctionBindings.controllerRuntimeCodeHash } });
  const before = state.calls.length;
  assert.equal((await sdk.resolveMarket(g9.id, { identity: identityOf(pins9) })).entry.generation, "gen9");
  assert.ok(state.calls.slice(before).every(call => call.address !== addr(BASES.gen8 + 1)), "the Gen8 curve is not read");
  assert.equal((await sdk.resolveMarket(g8.id, { identity: identityOf(pins8) })).entry.generation, "gen8");
  await assert.rejects(sdk.resolveMarket(g8.id, { identity: identityOf(pins9) }), code("IDENTITY_MISMATCH"));
  await assert.rejects(sdk.resolveMarket(g9.id, { identity: identityOf(pins8) }), code("IDENTITY_MISMATCH"));
  // A Gen8 curve claimed together with the Gen9 controller names no reviewed release at all.
  await assert.rejects(sdk.resolveMarket(g9.id, { identity: { ...identityOf(pins9), curve: pins8.curve } }), code("UNKNOWN_DEPLOYMENT"));
});
test("Gen8 and Gen9 stay distinct releases: neither can stand in for the other or share an identity", () => {
  const { rpc } = createWorld(), [gen8, gen9] = [manifest("gen8", BASES.gen8), manifest("gen9", BASES.gen9)];
  const only = (deployments: unknown[]) => createOxleyMarkets({ publicClient: rpc, deployments });
  assert.throws(() => only([gen8]).client("gen9"), code("UNKNOWN_DEPLOYMENT"));
  assert.throws(() => only([gen9]).client("gen8"), code("UNKNOWN_DEPLOYMENT"));
  assert.throws(() => only([gen9]).client("test-gen8"), code("UNKNOWN_DEPLOYMENT"));
  assert.equal(only([gen8, gen9]).generations.length, 2);
  assert.throws(() => only([gen8, { ...gen9, releaseId: gen8.releaseId }]), code("INVALID_DEPLOYMENT")); // same release name
  assert.throws(() => only([gen8, { ...gen9, curve: gen8.curve }]), code("INVALID_DEPLOYMENT")); // same curve
  // The fixture sits beside the bundled releases and is listed under its own generation, release and curve.
  const fixture = gen9Fixture(), released = testnetDeployments.filter(item => item.releaseId !== fixture.releaseId), listed = only([...released, fixture]).generations;
  assert.equal(listed.length, released.length + 1);
  assert.deepEqual(listed.slice(0, -1).map(item => item.releaseId), released.map(item => item.releaseId));
  assert.deepEqual(listed.at(-1), { generation: "gen9", releaseId: fixture.releaseId, status: "fixture", curve: fixture.curve.address, startBlock: "19000000" });
});
