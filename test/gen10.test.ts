import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { decodeFunctionData, type Hex } from "viem";
import { createOxleyMarkets, deploymentGeneration, gen10TestnetDeployment, GEN9_MAX_FLOOR_PRICE_WAD, OxleyError, parseDeployment, testnetDeployments, tokenAbi } from "../src/index.js";
import { createOxleyAuctionClient, GEN8_BID_RULES, parseAuctionDeployment } from "../src/auctions.js";
import { parseLaunchDeployment } from "../src/launch.js";
import { deploymentAddresses } from "../src/deployment-addresses.js";
import { addr, BASES, full, gen9Fixture, gen10Fixture, gen10Record, lowerAddresses, manifest, mockVerifiable, read } from "./support/chain.js";
import { auction, createAuctionWorld, dealId, NET_RAISE_30K, NET_RAISE_50K, owner, type AuctionWorld, type StoredBid } from "./support/auction.js";
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
/** Gen9's live terms registry (gen9-live-20261101/gen9-deployment.json roles.termsRegistry). Gen10 reuses it, so no wallet accepts the terms again. */
const GEN9_TERMS_REGISTRY = { address: "0x94c8c7203e2a01e37f104fa6cbe00382642c084d", runtimeCodeHash: "0x2aebc67f8fb67759321d1367cf8306bac96b66527b719f2598976994a87f052d" };

test("the Gen10 fixture is the live record mapped to a manifest: pinned by hash, equal to the bundled file, with its own identity, Gen8's Oxy-USDC and Gen9's terms registry", () => {
  const record = gen10Record(), fixture = gen10Fixture(), gen8 = gen8File(), parsed = parseDeployment(fixture);
  // The record is the owner's file byte for byte, and the evidence file names the same hash for it.
  const recordSha = createHash("sha256").update(read("test/fixtures/gen10-production-record.json")).digest("hex");
  const evidence = JSON.parse(read("docs/live-artifacts.json")).deployments.find((item: { file: string }) => item.file === "deployments/elysium-testnet-gen10.json");
  assert.equal(recordSha, "dfbbba541ecc9049b371fa6fafb0f4bb29c6ccc6ae081cadad2de4fe408d9e8f"); assert.equal(evidence.sourceSha256, recordSha);
  assert.deepEqual([evidence.sourcePath, evidence.schemaVersion], ["gen10-live-20261106/gen10-deployment.json", 3]);
  // The bundle is exactly the importer's mapping of that record.
  assert.equal(JSON.stringify(fixture, null, 2) + "\n", read("deployments/elysium-testnet-gen10.json")); assert.deepEqual(gen10TestnetDeployment, fixture);
  assert.doesNotThrow(() => scripts.validateManifest(scripts.manifestFor("gen10"), fixture));
  assert.deepEqual([record.generation, record.mode, record.activated, record.schemaVersion], ["gen10", "production", true, 3]);
  assert.equal(record.releaseId, `elysium-auctions-gen10-${record.planSha256.slice(0, 16)}`);
  // Identity and live pins.
  assert.equal(deploymentGeneration(parsed), "gen10"); assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.termsRegistry));
  assert.deepEqual([parsed.releaseId, parsed.status, parsed.chainId, parsed.network, parsed.startBlock],
    ["elysium-auctions-gen10-1fa4ef2a98fd14ed", "live", 99801, "testnet", "25237151"]);
  assert.deepEqual([parsed.curve.address, parsed.registry.address, parsed.auctionController],
    ["0x68926b5e1b479c1ba32fe8e87699dfe5cfe7bd91", "0x1e59df61e52f494492cf38ca6ae49a2eba259e13", "0xff729e724c54045d04846cde960c3c5ad5e892fd"]);
  assert.notEqual(parsed.releaseId, gen8.releaseId);
  assert.deepEqual([parsed.chainId, parsed.network, parsed.quoteToken], [gen8.chainId, gen8.network, gen8.quoteToken]);
  // Gen10 redeploys every role but the Oxy-USDC token and Gen9's terms registry. Runtime hashes include immutables, so they move with the addresses they bind;
  // only the exposure helper holds none, and its runtime is Gen8's byte for byte.
  const [mine, theirs] = [pinsOf(fixture), pinsOf(gen8)];
  assert.deepEqual(Object.keys(mine), Object.keys(theirs));
  for (const role of Object.keys(mine)) {
    assert.notEqual(mine[role]!.address, theirs[role]!.address, role);
    if (role === "exposureHelper") assert.equal(mine[role]!.runtimeCodeHash, theirs[role]!.runtimeCodeHash, role); else assert.notEqual(mine[role]!.runtimeCodeHash, theirs[role]!.runtimeCodeHash, role);
  }
  const [fixtureAddresses, gen8Addresses] = [deploymentAddresses(fixture), deploymentAddresses(gen8)];
  assert.deepEqual(fixtureAddresses.filter(item => gen8Addresses.includes(item)), [gen8.quoteToken.address]);
  assert.equal(fixtureAddresses.length, 9); assert.deepEqual(fixture.bidRules, GEN8_BID_RULES);
  assert.deepEqual(fixture.termsRegistry, GEN9_TERMS_REGISTRY); assert.notDeepEqual(fixture.termsRegistry, gen8.termsRegistry);
  assert.deepEqual(record.roles.termsRegistry, { address: GEN9_TERMS_REGISTRY.address, runtimeCodeHash: GEN9_TERMS_REGISTRY.runtimeCodeHash });
});
test("the importer maps the Gen10 record like Gen8's, refuses it in another slot and refuses a record that is not the Gen8 stack redeployed", () => {
  const record = lowerAddresses(gen10Record()), entry = scripts.manifestFor("gen10");
  const mapped = scripts.mapProductionManifest(entry, record), gen8 = gen8File();
  assert.deepEqual(Object.keys(mapped), Object.keys(gen8)); assert.deepEqual(mapped.quoteToken, gen8.quoteToken); assert.deepEqual(mapped.bidRules, gen8.bidRules);
  assert.throws(() => scripts.mapProductionManifest(scripts.manifestFor("gen9"), record), /releaseId must start with elysium-auctions-gen9-/);
  assert.throws(() => scripts.mapProductionManifest(scripts.manifestFor("gen8"), record), /releaseId must start with elysium-auctions-gen8-/);
  assert.throws(() => scripts.mapProductionManifest(entry, { ...record, activated: false }));
  assert.throws(() => scripts.mapProductionManifest(entry, { ...record, mode: "rehearsal" }));
  assert.throws(() => scripts.mapProductionManifest(entry, { ...record, releaseId: "elysium-auctions-gen9-1fa4ef2a98fd14ed" }), /releaseId must start with elysium-auctions-gen10-/);
});
test("a Gen10 auction deployment takes the Gen8 rules: all pins, the exact bid rules, and no launches", () => {
  const gen10 = gen10Fixture(), bindings: Record<string, unknown> = { ...gen10.auctionBindings };
  delete bindings.bidHook;
  const parsed = parseAuctionDeployment(gen10);
  assert.equal(parsed.auctionBindings.bidHook?.address, (gen10.auctionBindings as { bidHook: { address: string } }).bidHook.address);
  assert.ok(Object.isFrozen(parsed.auctionBindings.bidHook) && Object.isFrozen(parsed.bidRules));
  assert.throws(() => parseAuctionDeployment({ ...gen10, auctionBindings: bindings }), code("AUCTION_BINDINGS_REQUIRED"));
  assert.throws(() => parseAuctionDeployment({ ...gen10, bidRules: { ...GEN8_BID_RULES, minBid: "10000000" } }), code("INVALID_BID_RULES"));
  assert.throws(() => parseAuctionDeployment({ ...gen10, bidRules: undefined }), code("INVALID_BID_RULES"));
  assert.throws(() => parseAuctionDeployment({ ...gen10, termsRegistry: undefined }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseAuctionDeployment({ ...gen10, auctionBindings: { ...gen10.auctionBindings, bidHook: gen10.auctionBindings.adapter } }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseLaunchDeployment({ ...gen10, launchBindings: {} }), (error: unknown) => code("UNSUPPORTED_GENERATION")(error) && /Gen8, Gen9, or Gen10 launches/.test((error as Error).message));
});

const request = { dealId, caller: owner, entered: 100_000_000n, maxPriceQ96: 2000n, deadline: 5000n };
const stored = (id: bigint, maxPrice: bigint, startBlock: bigint): StoredBid => ({ id, owner, maxPrice, startBlock, amountQ96: 50_000_000n << 96n, exitedBlock: 0n });
function withBids(chain: AuctionWorld, ...bids: StoredBid[]) {
  chain.world.ids = bids.map(item => item.id); bids.forEach(item => chain.world.bids.set(item.id, item));
  chain.world.logs = [10n, 20n, 30n].map(block => ({ args: { blockNumber: block, clearingPriceQ96: chain.world.checkpoints.get(block)!.clearingPrice, cumulativeMps: 0 } }));
}
/** A Gen9 world ($50,000 net minimum raise) and a Gen10 world ($30,000), built from the fixtures' own addresses, both with the floor cap answered. */
const worlds = () => ({ gen8: createAuctionWorld(), gen9: createAuctionWorld(mockVerifiable(gen9Fixture()), GEN9_MAX_FLOOR_PRICE_WAD, NET_RAISE_50K),
  gen10: createAuctionWorld(mockVerifiable(gen10Fixture()), GEN9_MAX_FLOOR_PRICE_WAD, NET_RAISE_30K) });

test("Dynamic Bids on the Gen10 fixture give Gen9's calldata and limits; only the pinned router and the $3,030.30 opening ceiling differ", async () => {
  const { gen9, gen10 } = worlds();
  const [limits9, limits10] = [await gen9.client().getDynamicBidLimits({ dealId, owner }), await gen10.client().getDynamicBidLimits({ dealId, owner })];
  // The opening ceiling is ceil(minimumGrossRaise / 10): $5,050.505051 on Gen9, $3,030.303031 on Gen10. It is the only limit that moves.
  assert.deepEqual([limits9.ceiling, limits9.allowance], [5_050_505_051n, 5_050_505_051n]);
  assert.deepEqual([limits10.ceiling, limits10.allowance], [3_030_303_031n, 3_030_303_031n]);
  const { ceiling: _c9, allowance: _a9, maximumBid: max9, ...rest9 } = limits9, { ceiling: _c10, allowance: _a10, maximumBid: max10, ...rest10 } = limits10;
  assert.deepEqual(rest10, rest9); assert.deepEqual([max9, max10], [999_000_999n, 999_000_999n], "the 1,000 USDC test balance binds before either ceiling");
  withBids(gen9, stored(0n, 150n, 10n), stored(1n, 2500n, 25n)); withBids(gen10, stored(0n, 150n, 10n), stored(1n, 2500n, 25n));
  const [bid9, bid10] = [await gen9.client().prepareDynamicBid(request), await gen10.client().prepareDynamicBid(request)];
  assert.equal(bid10.transaction.data, bid9.transaction.data); assert.deepEqual([bid10.principal, bid10.fee, bid10.debit, bid10.previousTick], [bid9.principal, bid9.fee, bid9.debit, bid9.previousTick]);
  assert.equal(bid10.transaction.to, gen10.roles.router); assert.notEqual(bid10.transaction.to, bid9.transaction.to);
  const decoded = decodeFunctionData({ abi: full("ElysiumCcaBidRouterGen8"), data: bid10.transaction.data });
  assert.equal(decoded.functionName, "submitBid"); assert.equal(decoded.args?.[0], dealId);
  const approval = bid10.approvals[0]!;
  const [spender, amount] = decodeFunctionData({ abi: tokenAbi, data: approval.data }).args as [string, bigint];
  assert.deepEqual([approval.to, spender.toLowerCase(), amount], [gen10.roles.quote, gen10.roles.router, bid10.debit]);
  assert.equal(gen10.roles.quote, gen8File().quoteToken.address, "the bid is paid in the Oxy-USDC that Gen8 and Gen9 also use");
  // The generic bid path refuses every family member, naming all three.
  await assert.rejects(gen10.client().prepareBid({ ...request, previousTick: 1n }), (error: unknown) => code("DYNAMIC_BID_REQUIRED")(error) && /Gen8, Gen9, or Gen10/.test((error as Error).message));
});
test("a Gen10 rebid exits one outbid bid with its own witness, exactly like Gen8", async () => {
  const { gen8, gen10 } = worlds();
  const rebid = (chain: AuctionWorld) => {
    withBids(chain, stored(0n, 150n, 10n), stored(1n, 2500n, 25n)); chain.world.minimumRaiseMet = true;
    return chain.client().prepareDynamicRebid({ ...request, oldBidId: 0n });
  };
  const [rebid8, rebid10] = [await rebid(gen8), await rebid(gen10)];
  assert.equal(rebid10.transaction.data, rebid8.transaction.data); assert.deepEqual(rebid10.exit, { lastFull: 10n, outbid: 30n });
  assert.equal(decodeFunctionData({ abi: full("ElysiumCcaBidRouterGen8"), data: rebid10.transaction.data }).functionName, "rebid");
  await assert.rejects(gen10.client().prepareDynamicRebid({ ...request, oldBidId: 1n }), code("REBID_NOT_AVAILABLE"));
});
test("a Gen10 wallet's refusals match Gen8's, a bid between the two opening ceilings is refused on Gen10 only, and the Dynamic Bid paths stay closed outside the family", async () => {
  const refusals = async (chain: AuctionWorld) => {
    const results: string[] = [], attempt = async (patch: object) => chain.client().prepareDynamicBid({ ...request, ...patch }).then(() => "ok", (error: OxleyError) => error.code);
    results.push(await attempt({ entered: 19_999_999n }), await attempt({ maxPriceQ96: 2050n }), await attempt({ entered: 6_000_000_000n }));
    chain.world.termsAccepted = false; results.push(await attempt({})); chain.world.termsAccepted = true;
    chain.world.creatorExcluded = true; results.push(await attempt({}));
    return results;
  };
  const expected = ["BID_TOO_LOW", "INVALID_BID_PRICE", "WALLET_CAP_EXCEEDED", "TERMS_NOT_ACCEPTED", "CREATOR_BID_NOT_ALLOWED"];
  assert.deepEqual(await refusals(worlds().gen10), expected); assert.deepEqual(await refusals(worlds().gen8), expected);
  // A $4,000 bid is inside Gen9's $5,050.51 ceiling and above Gen10's $3,030.30: the hook's allowance on the chain decides, and the SDK honours it.
  const [gen9, gen10] = [worlds().gen9, worlds().gen10]; gen9.world.balance = gen10.world.balance = 10_000_000_000n;
  const big = { entered: 4_000_000_000n };
  assert.equal((await gen9.client().prepareDynamicBid({ ...request, ...big })).principal, 4_000_000_000n);
  await assert.rejects(gen10.client().prepareDynamicBid({ ...request, ...big }), (error: unknown) => code("WALLET_CAP_EXCEEDED")(error) && /up to 3030\.303031 Oxy-USDC/.test((error as Error).message));
  assert.equal((await gen10.client().prepareDynamicBid({ ...request, entered: 3_030_303_031n })).principal, 3_030_303_031n);
  const flat = createOxleyAuctionClient({ publicClient: worlds().gen10.rpc, deployment: manifest("flat-fee", 0) });
  await assert.rejects(flat.getDynamicBidLimits({ dealId, owner }), (error: unknown) => code("GEN8_REQUIRED")(error) && /Gen8, Gen9, or Gen10 deployments/.test((error as Error).message));
  await assert.rejects(flat.prepareDynamicBid(request), code("GEN8_REQUIRED"));
});
test("verifying a Gen10 deployment reads the controller's floor cap and its $30,000 minimum raise at one block; Gen8 has no floor cap to read", async () => {
  const { gen8, gen10 } = worlds();
  assert.equal((await gen10.client().verifyDeployment()).blockNumber, 100n);
  const reads = (chain: AuctionWorld, name: string) => chain.world.reads.filter(call => call.functionName === name).map(call => [call.address, call.blockNumber]);
  assert.deepEqual(reads(gen10, "MAX_FLOOR_PRICE_WAD"), [[gen10.roles.controller, 100n]]);
  assert.deepEqual(reads(gen10, "minimumRaise"), [[gen10.roles.controller, 100n]]); assert.deepEqual(reads(gen10, "minimumGrossRaise"), [[gen10.roles.controller, 100n]]);
  assert.equal((await gen8.client().verifyDeployment()).blockNumber, 100n);
  assert.deepEqual(reads(gen8, "minimumRaise"), [[gen8.roles.controller, 100n]]); assert.deepEqual(reads(gen8, "minimumGrossRaise"), [[gen8.roles.controller, 100n]]);
  assert.ok(gen8.world.reads.every(call => call.functionName !== "MAX_FLOOR_PRICE_WAD"));
  assert.equal((await gen10.client().getDynamicBidLimits({ dealId, owner })).blockNumber, 100n);
});
test("a controller with another minimum raise fails closed on every family member, so a $50,000 stack cannot pass as Gen10 nor a $30,000 one as Gen9", async () => {
  const [fixture9, fixture10] = [mockVerifiable(gen9Fixture()), mockVerifiable(gen10Fixture())];
  const cap = GEN9_MAX_FLOOR_PRICE_WAD;
  // The right pairs verify.
  await createAuctionWorld(fixture10, cap, NET_RAISE_30K).client().verifyDeployment();
  await createAuctionWorld(fixture9, cap, NET_RAISE_50K).client().verifyDeployment();
  await createAuctionWorld(undefined, undefined, NET_RAISE_50K).client().verifyDeployment();
  // Gen9's $50,000 controller under a Gen10 manifest, Gen10's $30,000 controller under a Gen9 or Gen8 manifest, and values around them.
  await assert.rejects(createAuctionWorld(fixture10, cap, NET_RAISE_50K).client().verifyDeployment(), (error: unknown) => code("AUCTION_BINDING_MISMATCH")(error) && /Gen10 controller's minimum raise differs from the 30,000 USDC/.test((error as Error).message));
  await assert.rejects(createAuctionWorld(fixture9, cap, NET_RAISE_30K).client().verifyDeployment(), (error: unknown) => code("AUCTION_BINDING_MISMATCH")(error) && /Gen9 controller's minimum raise differs from the 50,000 USDC/.test((error as Error).message));
  await assert.rejects(createAuctionWorld(undefined, undefined, NET_RAISE_30K).client().verifyDeployment(), (error: unknown) => code("AUCTION_BINDING_MISMATCH")(error) && /Gen8 controller's minimum raise differs from the 50,000 USDC/.test((error as Error).message));
  for (const net of [NET_RAISE_30K - 1n, NET_RAISE_30K + 1n, 29_700_000_000n, 40_000_000_000n, 0n]) {
    await assert.rejects(createAuctionWorld(fixture10, cap, net).client().verifyDeployment(), code("AUCTION_BINDING_MISMATCH"), String(net));
  }
  // The gross view is checked as well: the net value alone does not pass a controller whose gross figure disagrees.
  const liar = createAuctionWorld(fixture10, cap, NET_RAISE_30K); liar.world.minimumRaise = NET_RAISE_30K;
  const original = liar.rpc.readContract.bind(liar.rpc);
  (liar.rpc as { readContract: unknown }).readContract = async (call: { functionName: string }) => call.functionName === "minimumGrossRaise" ? 30_303_030_302n : original(call as never);
  await assert.rejects(liar.client().verifyDeployment(), code("AUCTION_BINDING_MISMATCH"));
});
test("a Gen10 manifest whose controller is uncapped or capped differently fails closed, and a changed hook, helper or terms registry does too", async () => {
  const fixture = mockVerifiable(gen10Fixture());
  for (const cap of [GEN9_MAX_FLOOR_PRICE_WAD - 1n, GEN9_MAX_FLOOR_PRICE_WAD * 2n, 0n]) {
    await assert.rejects(createAuctionWorld(fixture, cap, NET_RAISE_30K).client().verifyDeployment(), code("AUCTION_BINDING_MISMATCH"), String(cap));
  }
  await assert.rejects(createAuctionWorld(fixture, undefined, NET_RAISE_30K).client().verifyDeployment(), /MAX_FLOOR_PRICE_WAD/); // no getter: a Gen8 controller
  const relabelled = { ...createAuctionWorld().deployment, generation: "gen10" as never, releaseId: "elysium-auctions-gen10-relabelled" };
  await assert.rejects(createAuctionWorld(relabelled).client().verifyDeployment(), /MAX_FLOOR_PRICE_WAD/);
  const mutate: [string, (c: AuctionWorld) => void][] = [
    ["hook terms", c => { c.world.hookTerms = addr(99); }], ["hook rules", c => { c.world.hookRulesMinimum = 10_000_000n; }],
    ["exposure code", c => { c.state.codes.set(c.roles.exposure, "0x"); }], ["hook code", c => { c.state.codes.set(c.roles.hook, "0x"); }],
    ["terms code", c => { c.state.codes.set(c.roles.terms, "0x"); }],
  ];
  for (const [label, change] of mutate) {
    const chain = createAuctionWorld(fixture, GEN9_MAX_FLOOR_PRICE_WAD, NET_RAISE_30K); change(chain);
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
test("a Gen10 market resolves to the Gen10 curve and reports its own generation, beside Gen8 and Gen9", async () => {
  const { sdk, addMarket } = marketsWorld();
  const [g9, g10] = [addMarket("gen9", 2), addMarket("gen10", 3)];
  const [nine, ten] = [await sdk.resolveMarket(g9.id), await sdk.resolveMarket(g10.id)];
  assert.deepEqual([nine.entry.generation, nine.market.curve], ["gen9", addr(BASES.gen9 + 1)]);
  assert.deepEqual([ten.entry.generation, ten.market.generation, ten.market.curve, ten.market.coin], ["gen10", "gen10", addr(BASES.gen10 + 1), g10.coin]);
  assert.deepEqual(sdk.generations.map(item => [item.generation, item.releaseId]), ALL_GENERATIONS.map(g => [g, `test-${g}`]));
  assert.notEqual(sdk.client("gen10").deployment.releaseId, sdk.client("gen9").deployment.releaseId);
  assert.equal(sdk.client("test-gen10").deployment.generation, "gen10");
  const both = addMarket(["gen9", "gen10"], 4);
  await assert.rejects(sdk.resolveMarket(both.id), code("AMBIGUOUS_MARKET"));
});
test("Gen10 quotes and swaps take the quote-only Gen8 shapes: no account argument, four-argument sell, terms, gate and surcharge", async () => {
  const { sdk, addMarket, trade, world, state } = marketsWorld();
  const g10 = addMarket("gen10", 2);
  await sdk.resolveMarket(g10.id);
  const resolved = state.calls.length;
  world.surcharge = 90_000_000_000_000_000n; world.buy = { out: 800_000n, fee: 110_000n };
  const buy = await sdk.quote(trade(g10.id, g10.coin, "buy"));
  assert.deepEqual([buy.amountOut, buy.feeAmount, buy.openingSurchargeWad, buy.market.generation], [800_000n, 110_000n, 90_000_000_000_000_000n, "gen10"]);
  await sdk.quote(trade(g10.id, g10.coin, "sell"));
  assert.deepEqual(world.quoteCallers, [], "quote-only views take no account");
  const abi = full("ElysiumCurveGen8");
  const swap = await sdk.prepareSwap({ ...trade(g10.id, g10.coin, "buy"), slippageBps: 100 });
  assert.deepEqual(decodeFunctionData({ abi, data: swap.transaction.data }).args, [g10.id, 1_000_000n, 792_000n, 1300n]);
  assert.equal(swap.transaction.to, addr(BASES.gen10 + 1)); assert.equal(swap.quote.releaseId, "test-gen10");
  const sell = await sdk.prepareSwap({ ...trade(g10.id, g10.coin, "sell"), slippageBps: 100 });
  assert.deepEqual(decodeFunctionData({ abi, data: sell.transaction.data }).args, [g10.id, 10n ** 18n, 891_000n, 1300n]);
  const checked = await sdk.checkSwap(swap);
  assert.deepEqual([checked.termsAccepted, checked.approvals.length], [true, 1]);
  const terms = await sdk.getTermsStatus({ marketId: g10.id, account: addr(8) });
  assert.deepEqual([terms.termsRegistry, terms.enforced], [addr(BASES.gen10 + 5), false]);
  world.open = false;
  await assert.rejects(sdk.quote(trade(g10.id, g10.coin, "buy")), code("TRADING_NOT_OPEN"));
  world.open = true; world.paused = true;
  await assert.rejects(sdk.quote(trade(g10.id, g10.coin, "buy")), /BuysPaused/);
  assert.equal((await sdk.quote(trade(g10.id, g10.coin, "sell"))).side, "sell");
  assert.ok(state.calls.slice(resolved).every(call => ![BASES.gen8, BASES.gen9].some(base => call.address === addr(base + 1))), "a resolved Gen10 market never reads another family curve");
});
test("Gen9 and Gen10 share one terms registry: a wallet that accepted the terms on a Gen9 market is accepted on a Gen10 market", async () => {
  const chain = createWorld(), shared = manifest("gen9", BASES.gen9).termsRegistry!;
  const sdk = createOxleyMarkets({ publicClient: chain.rpc, deployments: [manifest("gen9", BASES.gen9), manifest("gen10", BASES.gen10, { termsRegistry: shared })] });
  chain.world.curveTerms.set("gen10", shared.address); // the Gen10 curve is bound to Gen9's registry
  chain.world.terms = { ...chain.world.terms, required: 2n, latest: 2n };
  const g9 = chain.addMarket("gen9", 1), g10 = chain.addMarket("gen10", 2), account = addr(8);
  chain.world.terms.accepted.set(account.toLowerCase(), 2n);
  const [onGen9, onGen10] = [await sdk.getTermsStatus({ marketId: g9.id, account }), await sdk.getTermsStatus({ marketId: g10.id, account })];
  assert.deepEqual([onGen9.termsRegistry, onGen10.termsRegistry], [shared.address, shared.address]);
  assert.deepEqual([onGen9.accepted, onGen10.accepted, onGen10.enforced, onGen10.acceptedVersion], [true, true, true, 2n]);
  assert.equal((await sdk.getTermsStatus({ marketId: g10.id, account: addr(9) })).accepted, false, "another wallet still has to accept, once, for both");
  // Still two releases: distinct names and curves are required even though the registry pin is common.
  assert.equal(sdk.generations.length, 2); assert.notEqual(sdk.client("gen9").deployment.curve.address, sdk.client("gen10").deployment.curve.address);
  // The Gen10 client verifies against that registry pin; a curve bound to some other registry is refused, as for any generation.
  assert.equal((await sdk.client("gen10").verifyDeployment()).blockNumber, 100n);
  chain.world.curveTerms.set("gen10", addr(77));
  await assert.rejects(sdk.client("gen10").verifyDeployment(), code("TERMS_BINDING_MISMATCH"));
});
test("a deployment identity picks the Gen10 curve by address and no other family identity matches a Gen10 market", async () => {
  const { sdk, addMarket, state } = marketsWorld();
  const g10 = addMarket("gen10", 1), g9 = addMarket("gen9", 2), [pins9, pins10] = [manifests()[3]!, manifests()[4]!];
  const identityOf = (pins: ReturnType<typeof manifest>) => ({ chainId: 31337, curve: pins.curve, quote: pins.quoteToken,
    controller: { address: pins.auctionController, runtimeCodeHash: pins.auctionBindings.controllerRuntimeCodeHash } });
  const before = state.calls.length;
  assert.equal((await sdk.resolveMarket(g10.id, { identity: identityOf(pins10) })).entry.generation, "gen10");
  assert.ok(state.calls.slice(before).every(call => call.address !== addr(BASES.gen9 + 1)), "the Gen9 curve is not read");
  assert.equal((await sdk.resolveMarket(g9.id, { identity: identityOf(pins9) })).entry.generation, "gen9");
  await assert.rejects(sdk.resolveMarket(g9.id, { identity: identityOf(pins10) }), code("IDENTITY_MISMATCH"));
  await assert.rejects(sdk.resolveMarket(g10.id, { identity: identityOf(pins9) }), code("IDENTITY_MISMATCH"));
  await assert.rejects(sdk.resolveMarket(g10.id, { identity: { ...identityOf(pins10), curve: pins9.curve } }), code("UNKNOWN_DEPLOYMENT"));
});
test("Gen9 and Gen10 stay distinct releases: neither can stand in for the other, share a name or share a curve", () => {
  const { rpc } = createWorld(), [gen9, gen10] = [manifest("gen9", BASES.gen9), manifest("gen10", BASES.gen10)];
  const only = (deployments: unknown[]) => createOxleyMarkets({ publicClient: rpc, deployments });
  assert.throws(() => only([gen9]).client("gen10"), code("UNKNOWN_DEPLOYMENT"));
  assert.throws(() => only([gen10]).client("gen9"), code("UNKNOWN_DEPLOYMENT"));
  assert.throws(() => only([gen10]).client("test-gen9"), code("UNKNOWN_DEPLOYMENT"));
  assert.equal(only([gen9, gen10]).generations.length, 2);
  assert.throws(() => only([gen9, { ...gen10, releaseId: gen9.releaseId }]), code("INVALID_DEPLOYMENT")); // same release name
  assert.throws(() => only([gen9, { ...gen10, curve: gen9.curve }]), code("INVALID_DEPLOYMENT")); // same curve
  // The bundle lists the live Gen10 release last, as its newest generation, and the default router resolves it by generation name.
  const released = testnetDeployments.filter(item => item.releaseId === gen10TestnetDeployment.releaseId);
  assert.equal(released.length, 1); assert.equal(testnetDeployments.at(-1), gen10TestnetDeployment);
  const listed = createOxleyMarkets({ publicClient: rpc }).generations;
  assert.deepEqual(listed.at(-1), { generation: "gen10", releaseId: "elysium-auctions-gen10-1fa4ef2a98fd14ed", status: "live",
    curve: "0x68926b5e1b479c1ba32fe8e87699dfe5cfe7bd91", startBlock: "25237151" });
  assert.equal(createOxleyMarkets({ publicClient: rpc }).client("gen10").deployment.releaseId, "elysium-auctions-gen10-1fa4ef2a98fd14ed");
  assert.throws(() => createOxleyMarkets({ publicClient: rpc }).client("gen9"), code("UNKNOWN_DEPLOYMENT"));
  // The live Gen10 manifest and the Gen9 fixture can be listed together.
  const withGen9 = createOxleyMarkets({ publicClient: rpc, deployments: [...testnetDeployments, gen9Fixture()] }).generations;
  assert.deepEqual(withGen9.map(item => item.generation), ["flat-fee", "gen3", "gen8", "gen10", "gen9"]);
});
