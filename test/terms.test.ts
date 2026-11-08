import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import { buildAcceptTerms, createOxleyClient, OxleyError, termsRegistryAbi } from "../src/index.js";
import { addr, full, id32, manifest } from "./support/chain.js";
import { CURVE, createWorld, TERMS } from "./support/world.js";

const account = addr(8), termsHash = id32(77);
const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
function setup() {
  const chain = createWorld(), sdk = createOxleyClient({ publicClient: chain.rpc, deployment: manifest() });
  return { ...chain, sdk, market: chain.addMarket(1) };
}

test("a registry that enforces nothing reports itself while the required version is zero", async () => {
  const { sdk } = setup();
  const status = await sdk.getTermsStatus(account);
  assert.deepEqual([status.termsRegistry, status.enforced, status.accepted, status.termsHash, status.uri], [TERMS, false, true, null, null]);
  const prepared = await sdk.prepareAcceptTerms({ account });
  assert.deepEqual([prepared.transaction, prepared.simulated], [null, false]);
});
test("an unaccepted required version yields a simulated acceptTerms transaction that carries the registry's own hash", async () => {
  const { sdk, world, state } = setup();
  Object.assign(world.terms, { required: 2n, latest: 3n });
  const status = await sdk.getTermsStatus(account);
  assert.deepEqual([status.enforced, status.accepted, status.requiredVersion, status.latestVersion, status.acceptedVersion],
    [true, false, 2n, 3n, 0n]);
  assert.deepEqual([status.termsHash, status.uri], [termsHash, "ipfs://terms"]);
  const prepared = await sdk.prepareAcceptTerms({ account });
  assert.equal(prepared.transaction?.to, TERMS); assert.equal(prepared.transaction?.value, 0n); assert.equal(prepared.simulated, true);
  const decoded = decodeFunctionData({ abi: full("terms-registry"), data: prepared.transaction!.data });
  assert.deepEqual([decoded.functionName, decoded.args], ["acceptTerms", [2n, termsHash]]);
  assert.deepEqual(state.simulations.map(call => [call.to, call.account]), [[TERMS, account]]);
  // Acceptance only moves forward: version 1 no longer suffices once 2 is required; any version at or above it does.
  world.terms.accepted.set(account, 1n);
  assert.equal((await sdk.getTermsStatus(account)).accepted, false);
  world.terms.accepted.set(account, 2n);
  assert.deepEqual([(await sdk.prepareAcceptTerms({ account })).transaction], [null]);
  world.terms.accepted.set(account, 9n);
  assert.equal((await sdk.getTermsStatus(account)).accepted, true);
});
test("registry views that contradict each other, or required terms that were never published, fail closed", async () => {
  const { sdk, world } = setup();
  Object.assign(world.terms, { required: 2n, latest: 3n, hasAcceptedOverride: true });
  await assert.rejects(sdk.getTermsStatus(account), code("INVALID_TERMS_STATE"));
  Object.assign(world.terms, { hasAcceptedOverride: undefined, required: 4n });
  await assert.rejects(sdk.getTermsStatus(account), code("INVALID_TERMS_STATE"));
  Object.assign(world.terms, { required: 2n, hash: id32(0) });
  await assert.rejects(sdk.getTermsStatus(account), code("INVALID_TERMS_STATE"));
});
test("a registry that rejects the acceptance is reported, not swallowed", async () => {
  const { sdk, world } = setup();
  Object.assign(world.terms, { required: 1n, latest: 1n });
  world.callError = new Error("AlreadyAccepted");
  await assert.rejects(sdk.prepareAcceptTerms({ account }), code("TERMS_ACCEPTANCE_REVERTED"));
});
test("swap checks report unaccepted terms and refuse to simulate until they are accepted", async () => {
  const { sdk, market, world } = setup();
  Object.assign(world.terms, { required: 1n, latest: 1n });
  const quote = { marketId: market.id, tokenIn: addr(3), tokenOut: market.coin, amountIn: 1_000_000n, caller: account, slippageBps: 50 };
  world.allowances.set(`${addr(3)}:${account}:${CURVE}`, 1_000_000n);
  const swap = await sdk.prepareSwap(quote);
  const checked = await sdk.checkSwap(swap);
  assert.deepEqual([checked.termsAccepted, checked.terms.enforced, checked.approvals.length], [false, true, 0]);
  await assert.rejects(sdk.checkSwap(swap, true), code("TERMS_NOT_ACCEPTED"));
  world.terms.accepted.set(account, 1n);
  assert.deepEqual([(await sdk.checkSwap(swap, true)).termsAccepted, (await sdk.checkSwap(swap, true)).gas], [true, 200_000n]);
});
test("the curve must be bound to the manifest's terms registry, whose runtime code is pinned", async () => {
  const { sdk, state, world } = setup();
  world.curveTerms = addr(99);
  await assert.rejects(sdk.verifyDeployment(), code("TERMS_BINDING_MISMATCH"));
  world.curveTerms = TERMS;
  assert.equal((await sdk.verifyDeployment()).blockNumber, 100n);
  state.codes.set(TERMS, "0x");
  await assert.rejects(sdk.verifyDeployment(), code("CODE_MISMATCH"));
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
