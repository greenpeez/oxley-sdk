import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import { buildAcceptTerms, createOxleyMarkets, OxleyError, termsRegistryAbi } from "../src/index.js";
import { addr, BASES, full, id32, manifest } from "./support/chain.js";
import { createWorld, GENERATIONS } from "./support/world.js";

const account = addr(8), termsHash = id32(77);
const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
function setup() {
  const chain = createWorld();
  const sdk = createOxleyMarkets({ publicClient: chain.rpc, deployments: GENERATIONS.map(generation => manifest(generation, BASES[generation])) });
  const markets = { flat: chain.addMarket("flat-fee", 1), g3: chain.addMarket("gen3", 2), g8: chain.addMarket("gen8", 3) };
  return { ...chain, sdk, markets };
}

test("a curve without terms reports none; Gen3 and Gen8 report a registry that enforces nothing while the required version is zero", async () => {
  const { sdk, markets } = setup();
  const flat = await sdk.getTermsStatus({ marketId: markets.flat.id, account });
  assert.deepEqual([flat.termsRegistry, flat.enforced, flat.accepted, flat.termsHash], [null, false, true, null]);
  assert.equal((await sdk.prepareAcceptTerms({ marketId: markets.flat.id, account })).transaction, null);
  for (const [market, generation] of [[markets.g3, "gen3"], [markets.g8, "gen8"]] as const) {
    const status = await sdk.getTermsStatus({ marketId: market.id, account });
    assert.deepEqual([status.termsRegistry, status.enforced, status.accepted], [addr(BASES[generation] + 5), false, true]);
    const prepared = await sdk.prepareAcceptTerms({ marketId: market.id, account });
    assert.deepEqual([prepared.transaction, prepared.simulated], [null, false]);
  }
});
test("an unaccepted required version yields a simulated acceptTerms transaction that carries the registry's own hash", async () => {
  const { sdk, markets, world, state } = setup();
  Object.assign(world.terms, { required: 2n, latest: 3n });
  const status = await sdk.getTermsStatus({ marketId: markets.g8.id, account });
  assert.deepEqual([status.enforced, status.accepted, status.requiredVersion, status.latestVersion, status.acceptedVersion],
    [true, false, 2n, 3n, 0n]);
  assert.deepEqual([status.termsHash, status.uri], [termsHash, "ipfs://terms"]);
  const prepared = await sdk.prepareAcceptTerms({ marketId: markets.g8.id, account });
  assert.equal(prepared.transaction?.to, addr(BASES.gen8 + 5)); assert.equal(prepared.transaction?.value, 0n);
  const decoded = decodeFunctionData({ abi: full("OxleyTermsRegistry"), data: prepared.transaction!.data });
  assert.deepEqual([decoded.functionName, decoded.args], ["acceptTerms", [2n, termsHash]]);
  assert.deepEqual(state.simulations.map(call => [call.to, call.account]), [[addr(BASES.gen8 + 5), account]]);
  // Acceptance only moves forward: version 1 no longer suffices once 2 is required; any version at or above it does.
  world.terms.accepted.set(account, 1n);
  assert.equal((await sdk.getTermsStatus({ marketId: markets.g8.id, account })).accepted, false);
  world.terms.accepted.set(account, 2n);
  assert.deepEqual([(await sdk.prepareAcceptTerms({ marketId: markets.g8.id, account })).transaction], [null]);
  world.terms.accepted.set(account, 9n);
  assert.equal((await sdk.getTermsStatus({ marketId: markets.g8.id, account })).accepted, true);
});
test("registry views that contradict each other, or required terms that were never published, fail closed", async () => {
  const { sdk, markets, world } = setup();
  Object.assign(world.terms, { required: 2n, latest: 3n, hasAcceptedOverride: true });
  await assert.rejects(sdk.getTermsStatus({ marketId: markets.g3.id, account }), code("INVALID_TERMS_STATE"));
  Object.assign(world.terms, { hasAcceptedOverride: undefined, required: 4n });
  await assert.rejects(sdk.getTermsStatus({ marketId: markets.g3.id, account }), code("INVALID_TERMS_STATE"));
  Object.assign(world.terms, { required: 2n, hash: id32(0) });
  await assert.rejects(sdk.getTermsStatus({ marketId: markets.g3.id, account }), code("INVALID_TERMS_STATE"));
});
test("a registry that rejects the acceptance is reported, not swallowed", async () => {
  const { sdk, markets, world } = setup();
  Object.assign(world.terms, { required: 1n, latest: 1n });
  world.callError = new Error("AlreadyAccepted");
  await assert.rejects(sdk.prepareAcceptTerms({ marketId: markets.g3.id, account }), code("TERMS_ACCEPTANCE_REVERTED"));
});
test("swap checks report unaccepted terms and refuse to simulate until they are accepted", async () => {
  const { sdk, markets, world } = setup();
  Object.assign(world.terms, { required: 1n, latest: 1n });
  const quote = { marketId: markets.g8.id, tokenIn: addr(3), tokenOut: markets.g8.coin, amountIn: 1_000_000n, caller: account, slippageBps: 50 };
  world.allowances.set(`${addr(3)}:${account}:${addr(BASES.gen8 + 1)}`, 1_000_000n);
  const swap = await sdk.prepareSwap(quote);
  const checked = await sdk.checkSwap(swap);
  assert.deepEqual([checked.termsAccepted, checked.terms.enforced, checked.approvals.length], [false, true, 0]);
  await assert.rejects(sdk.checkSwap(swap, true), code("TERMS_NOT_ACCEPTED"));
  world.terms.accepted.set(account, 1n);
  assert.deepEqual([(await sdk.checkSwap(swap, true)).termsAccepted, (await sdk.checkSwap(swap, true)).gas], [true, 200_000n]);
});
test("the curve must be bound to the manifest's terms registry, whose runtime code is pinned", async () => {
  const { sdk, state, world } = setup();
  world.curveTerms.set("gen3", addr(99));
  await assert.rejects(sdk.client("gen3").verifyDeployment(), code("TERMS_BINDING_MISMATCH"));
  world.curveTerms.delete("gen3");
  assert.equal((await sdk.client("gen3").verifyDeployment()).blockNumber, 100n);
  state.codes.set(addr(BASES.gen8 + 5).toLowerCase(), "0x");
  await assert.rejects(sdk.client("gen8").verifyDeployment(), code("CODE_MISMATCH"));
});
test("buildAcceptTerms encodes the registry call and validates every input", () => {
  const good = { chainId: 99801, termsRegistry: addr(15), version: 2n, termsHash };
  const tx = buildAcceptTerms(good);
  assert.deepEqual([tx.chainId, tx.to, tx.value], [99801, addr(15), 0n]);
  assert.deepEqual(decodeFunctionData({ abi: termsRegistryAbi, data: tx.data }).args, [2n, termsHash]);
  for (const bad of [{ chainId: 0 }, { chainId: 1.5 }, { termsRegistry: addr(0) }, { termsHash: id32(0) }, { version: 0n }, { version: 1n << 64n }, { version: 1 }]) {
    assert.throws(() => buildAcceptTerms({ ...good, ...bad } as typeof good), OxleyError, JSON.stringify(bad, (_, v) => typeof v === "bigint" ? String(v) : v));
  }
});
