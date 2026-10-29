import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { decodeFunctionData, type Hex } from "viem";
import { createOxleyClient, createOxleyMarkets, deploymentGeneration, parseDeployment, testnetDeployments, flatFeeTestnetDeployment,
  gen3TestnetDeployment, gen8TestnetDeployment, OxleyError } from "../src/index.js";
import { addr, BASES, full, manifest, read, type Generation } from "./support/chain.js";
import { createWorld, GENERATIONS } from "./support/world.js";

const manifests = GENERATIONS.map(generation => manifest(generation, BASES[generation]));
const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const caller = addr(8);
function setup() {
  const chain = createWorld();
  const sdk = createOxleyMarkets({ publicClient: chain.rpc, deployments: manifests });
  const request = (marketId: Hex, coin: string, side: "buy" | "sell") => ({ marketId, caller, amountIn: side === "buy" ? 1_000_000n : 10n ** 18n,
    tokenIn: side === "buy" ? addr(3) : coin as `0x${string}`, tokenOut: side === "buy" ? coin as `0x${string}` : addr(3) });
  return { ...chain, sdk, request };
}

test("bundled manifests are verbatim copies of the reviewed JSON and parse as their own generation", () => {
  const files = ["elysium-testnet", "elysium-testnet-gen3", "elysium-testnet-gen8"];
  [flatFeeTestnetDeployment, gen3TestnetDeployment, gen8TestnetDeployment].forEach((embedded, index) =>
    assert.deepEqual(JSON.parse(read(`deployments/${files[index]}.json`)), embedded, files[index]!));
  const parsed = testnetDeployments.map(item => parseDeployment(item));
  assert.deepEqual(parsed.map(deploymentGeneration), ["flat-fee", "gen3", "gen8"]);
  assert.ok(parsed.every(item => item.chainId === 99801 && item.network === "testnet"));
  assert.deepEqual(parsed.map(item => item.curve.address), ["0x18bf92514c0d749a017aaf69153442703e1a966b",
    "0xb7e3e9b2ea74e3051f5c40ce7eb0486b0ab793d3", "0x434fd4f556800634399b9f96a4d148de215458e5"]);
  assert.deepEqual(parsed.map(item => item.termsRegistry?.address), [undefined, "0xcba1762cf892868e4afc92ce63813aba21f895e8",
    "0x4e6598e8b9b629b37859a1c12d0d9fe169199976"]);
  assert.equal(parsed[0]!.releaseId, "elysium-auctions-flat-fee-7006d7889ab293d3");
  // The embedded module is generated: it must not drift from the JSON files.
  assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/embed-deployments.mjs", "--check"], { stdio: "pipe" }));
});
test("terms registry pins belong to Gen3 and Gen8 only, and the generation set is closed", () => {
  const gen3 = manifest("gen3", 10), flat = manifest("flat-fee", 0), { termsRegistry: pinned, ...withoutTerms } = gen3, termsRegistry = pinned!;
  assert.equal(parseDeployment(gen3).termsRegistry?.address, termsRegistry.address);
  assert.throws(() => parseDeployment(withoutTerms), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseDeployment({ ...flat, termsRegistry }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseDeployment({ ...gen3, termsRegistry: { ...termsRegistry, address: gen3.curve.address } }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseDeployment({ ...gen3, termsRegistry: { address: addr(0), runtimeCodeHash: termsRegistry.runtimeCodeHash } }), code("INVALID_ADDRESS"));
  assert.throws(() => parseDeployment({ ...gen3, generation: "gen4" }), code("INVALID_GENERATION"));
  assert.equal(parseDeployment({ ...flat, generation: "flat-fee" }).generation, "flat-fee");
});
test("each generation resolves on chain to its own curve and reports the market's generation", async () => {
  const { sdk, addMarket } = setup();
  for (const generation of GENERATIONS) {
    const market = addMarket(generation, GENERATIONS.indexOf(generation) + 1);
    const resolved = await sdk.resolveMarket(market.id);
    assert.equal(resolved.entry.generation, generation); assert.equal(resolved.market.generation, generation);
    assert.equal(resolved.market.curve, addr(BASES[generation] + 1)); assert.equal(resolved.market.coin, market.coin);
  }
  assert.deepEqual(sdk.generations.map(item => item.generation), GENERATIONS);
});
test("quotes use each generation's own views and report the real fee, including the opening surcharge rate", async () => {
  const { sdk, addMarket, request, world } = setup();
  world.surcharge = 90_000_000_000_000_000n; world.buy = { out: 800_000n, fee: 110_000n };
  for (const generation of GENERATIONS) {
    const market = addMarket(generation, GENERATIONS.indexOf(generation) + 1);
    const buy = await sdk.quote(request(market.id, market.coin, "buy"));
    assert.equal(buy.amountOut, 800_000n); assert.equal(buy.feeAmount, 110_000n);
    assert.equal(buy.openingSurchargeWad, generation === "flat-fee" ? undefined : 90_000_000_000_000_000n);
    const sell = await sdk.quote(request(market.id, market.coin, "sell"));
    assert.equal(sell.amountOut, 900_000n); assert.equal(sell.feeAmount, 20_000n); assert.equal(sell.openingSurchargeWad, undefined);
  }
  // Gen8 quote views take no account; the others receive the actual caller for rebates.
  assert.deepEqual(world.quoteCallers, [caller, caller, caller, caller]);
});
test("collateral-returning sells stay rejected on Gen3 and buys paused on Gen8 reject while sells continue", async () => {
  const { sdk, addMarket, request, world } = setup();
  const g3 = addMarket("gen3", 1), g8 = addMarket("gen8", 2);
  world.sell.collateral = 1n;
  await assert.rejects(sdk.quote(request(g3.id, g3.coin, "sell")), code("COLLATERAL_OUTPUT"));
  world.sell.collateral = 0n; world.paused = true;
  await assert.rejects(sdk.quote(request(g8.id, g8.coin, "buy")), /BuysPaused/);
  assert.equal((await sdk.quote(request(g8.id, g8.coin, "sell"))).side, "sell");
});
test("swap calldata matches the full compiled ABI of each curve (Gen8 sell has four arguments)", async () => {
  const { sdk, addMarket, request } = setup();
  const abis: Record<Generation, string> = { "flat-fee": "ElysiumReserveCurveVNext", gen3: "ElysiumReserveCurveGen3", gen8: "ElysiumCurveGen8" };
  for (const generation of GENERATIONS) {
    const market = addMarket(generation, GENERATIONS.indexOf(generation) + 1), abi = full(abis[generation]);
    const buy = await sdk.prepareSwap({ ...request(market.id, market.coin, "buy"), slippageBps: 100 });
    assert.deepEqual(decodeFunctionData({ abi, data: buy.transaction.data }).args, [market.id, 1_000_000n, 891_000n, 1300n]);
    assert.equal(buy.transaction.to, addr(BASES[generation] + 1)); assert.equal(buy.amountInOffset, 36);
    const sell = await sdk.prepareSwap({ ...request(market.id, market.coin, "sell"), slippageBps: 100 });
    const decoded = decodeFunctionData({ abi, data: sell.transaction.data });
    assert.equal(decoded.functionName, "sell");
    assert.deepEqual(decoded.args, generation === "gen8" ? [market.id, 10n ** 18n, 891_000n, 1300n] : [market.id, 10n ** 18n, 891_000n, 0n, 1300n]);
  }
});
test("Gen2+ curves fail closed while the trading gate is closed; the status reports the fallback time", async () => {
  const { sdk, addMarket, request, world } = setup();
  const flat = addMarket("flat-fee", 1), g3 = addMarket("gen3", 2), g8 = addMarket("gen8", 3);
  world.open = false;
  await assert.rejects(sdk.quote(request(g3.id, g3.coin, "buy")), code("TRADING_NOT_OPEN"));
  await assert.rejects(sdk.prepareSwap({ ...request(g8.id, g8.coin, "buy"), slippageBps: 50 }), code("TRADING_NOT_OPEN"));
  assert.equal((await sdk.quote(request(flat.id, flat.coin, "buy"))).side, "buy");
  assert.deepEqual(await sdk.getTradingStatus(g3.id).then(({ gated, open, fallbackAt }) => ({ gated, open, fallbackAt })),
    { gated: true, open: false, fallbackAt: 1300n });
  assert.equal((await sdk.getTradingStatus(flat.id)).gated, false);
});
test("an unknown or inactive market is not found, and a failed read is never reported as not found", async () => {
  const { sdk, addMarket, world } = setup();
  const inactive = addMarket("gen3", 1, false), ghost = addr(1);
  await assert.rejects(sdk.resolveMarket(inactive.id), (error: unknown) => code("UNSUPPORTED_MARKET")(error)
    && (error as OxleyError).details?.checked instanceof Array && ((error as OxleyError).details!.checked as string[]).length === 3);
  await assert.rejects(sdk.resolveMarket(`0x${"ab".repeat(32)}`), code("UNSUPPORTED_MARKET"));
  await assert.rejects(sdk.resolveMarket(ghost as unknown as Hex), code("INVALID_HASH"));
  const live = addMarket("gen8", 2);
  world.failures.set(`${addr(BASES.gen3 + 1)}:market`, new Error("rpc is down"));
  await assert.rejects(sdk.resolveMarket(inactive.id), /rpc is down/);
  // A verified match elsewhere still resolves: a market ID belongs to one registry.
  assert.equal((await sdk.resolveMarket(live.id)).entry.generation, "gen8");
});
test("a market listed by two generations is ambiguous, never picked", async () => {
  const { sdk, addMarket } = setup();
  const both = addMarket(["gen3", "gen8"], 1);
  await assert.rejects(sdk.resolveMarket(both.id), code("AMBIGUOUS_MARKET"));
});
test("a deployment identity narrows the search but the chain still decides", async () => {
  const { sdk, addMarket, state } = setup();
  const g3 = addMarket("gen3", 1), flat = addMarket("flat-fee", 2);
  const identity = { chainId: 31337, curve: { address: addr(BASES.gen3 + 1).toUpperCase().replace("0X", "0x"), runtimeCodeHash: manifests[1]!.curve.runtimeCodeHash } };
  const before = state.calls.length;
  assert.equal((await sdk.resolveMarket(g3.id, { identity })).entry.generation, "gen3");
  assert.ok(state.calls.slice(before).every(call => call.address !== addr(BASES["flat-fee"] + 1)), "other curves are not read");
  await assert.rejects(sdk.resolveMarket(flat.id, { identity }), code("IDENTITY_MISMATCH"));
  for (const bad of [{ curve: { address: addr(77) } }, { ...identity, chainId: 1 }, { curve: { ...identity.curve, runtimeCodeHash: `0x${"11".repeat(32)}` } }]) {
    await assert.rejects(sdk.resolveMarket(g3.id, { identity: bad }), code("UNKNOWN_DEPLOYMENT"));
  }
});
test("a resolved market is remembered, so later calls read only its own generation", async () => {
  const { sdk, addMarket, state, request } = setup();
  const g8 = addMarket("gen8", 1);
  await sdk.resolveMarket(g8.id);
  const before = state.calls.length;
  await sdk.quote(request(g8.id, g8.coin, "buy"));
  const curvesRead = new Set(state.calls.slice(before).filter(call => call.functionName === "market").map(call => call.address));
  assert.deepEqual([...curvesRead], [addr(BASES.gen8 + 1)]);
});
test("prepared swaps are checked by the generation that produced them; foreign releases are refused", async () => {
  const { sdk, addMarket, request } = setup();
  const g3 = addMarket("gen3", 1), g8 = addMarket("gen8", 2);
  for (const market of [g3, g8]) {
    const swap = await sdk.prepareSwap({ ...request(market.id, market.coin, "buy"), slippageBps: 50 });
    const checked = await sdk.checkSwap(swap);
    assert.equal(checked.approvals.length, 1); assert.equal(checked.termsAccepted, true);
  }
  const swap = await sdk.prepareSwap({ ...request(g3.id, g3.coin, "buy"), slippageBps: 50 });
  await assert.rejects(sdk.checkSwap({ ...swap, quote: { ...swap.quote, releaseId: "elsewhere" } }), code("UNKNOWN_DEPLOYMENT"));
  assert.equal(sdk.client("gen8").deployment.releaseId, "test-gen8"); assert.equal(sdk.client("test-gen3").deployment.generation, "gen3");
  assert.throws(() => sdk.client("gen2"), code("UNKNOWN_DEPLOYMENT"));
});
test("a router needs distinct reviewed releases on one chain", () => {
  const { rpc } = createWorld();
  assert.throws(() => createOxleyMarkets({ publicClient: rpc, deployments: [] }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => createOxleyMarkets({ publicClient: rpc, deployments: [manifests[0], manifests[0]] }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => createOxleyMarkets({ publicClient: rpc, deployments: [manifests[0], { ...manifest("gen3", 10), chainId: 1 }] }), code("INVALID_DEPLOYMENT"));
  assert.equal(createOxleyMarkets({ publicClient: rpc }).generations.length, 3);
  assert.equal(createOxleyClient({ publicClient: rpc, deployment: manifests[2] }).deployment.generation, "gen8");
});
