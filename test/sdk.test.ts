import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, getAbiItem, toEventSelector, toHex, type AbiEvent, type Hex } from "viem";
import { createOxleyClient, buildApprovals, buildSwap, minimumAmountOut, curveAbi, tokenAbi, testnetDeployment } from "../src/index.js";
import { buildZeroExBasic, zeroExBasicAbi } from "../src/zero-ex.js";
import { addr, blockHash, full, manifest } from "./support/chain.js";
import { CURVE, createWorld } from "./support/world.js";

function fixture() {
  const chain = createWorld(), market = chain.addMarket(5), sdk = createOxleyClient({ publicClient: chain.rpc, deployment: manifest() });
  const request = { marketId: market.id, tokenIn: addr(3), tokenOut: market.coin, amountIn: 1_000_000n, caller: addr(8) };
  const holdings = (balance: bigint, allowance: bigint) => {
    chain.world.balances.set(`${addr(3)}:${addr(8)}`, balance);
    chain.world.allowances.set(`${addr(3)}:${addr(8)}:${CURVE}`, allowance);
  };
  return { ...chain, market, sdk, request, holdings };
}

test("quotes are net on-chain outputs, pinned to a block, with no balance or allowance dependency and no account argument", async () => {
  const { sdk, request, state, world } = fixture();
  const quote = await sdk.quote(request);
  assert.equal(quote.amountOut, 900_000n); assert.equal(quote.feeAmount, 20_000n); assert.equal(quote.feeToken, addr(3));
  assert.equal(quote.blockHash, blockHash); assert.equal(quote.blockNumber, 100n);
  assert.deepEqual(world.quoted, [{ side: "buy", amount: 1_000_000n }]);
  assert.deepEqual(state.calls.find(call => call.functionName === "quoteBuy")!.args, [request.marketId, 1_000_000n]);
  assert.ok(!state.calls.some(call => call.functionName === "balanceOf" || call.functionName === "allowance"));
});
test("buy and sell calldata preserve all financial protections; BASIC patches amount at byte 36", async () => {
  const { sdk, request } = fixture();
  for (const sell of [false, true]) {
    const input = sell ? { ...request, tokenIn: request.tokenOut, tokenOut: request.tokenIn } : request;
    const swap = await sdk.prepareSwap({ ...input, slippageBps: 50 });
    const decoded = decodeFunctionData({ abi: curveAbi, data: swap.transaction.data });
    assert.equal(decoded.functionName, sell ? "sell" : "buy");
    assert.deepEqual(decoded.args, [request.marketId, 1_000_000n, 895_500n, 1300n]);
    const offset = 2 + swap.amountInOffset * 2;
    const patched = `${swap.transaction.data.slice(0, offset)}${toHex(250_000n, { size: 32 }).slice(2)}${swap.transaction.data.slice(offset + 64)}` as Hex;
    assert.equal(decodeFunctionData({ abi: curveAbi, data: patched }).args?.[1], 250_000n);
    const action = decodeFunctionData({ abi: zeroExBasicAbi, data: buildZeroExBasic(swap, 250_000).data });
    assert.deepEqual(action.args, [input.tokenIn, 250_000n, CURVE, 36n, swap.transaction.data]);
    assert.equal(swap.rewardBeneficiary, request.caller); assert.equal(swap.outputReceiver, request.caller);
  }
});
test("exact approvals use zero-first, never unlimited approval or the Settler as spender", async () => {
  const { sdk, request } = fixture();
  const swap = await sdk.prepareSwap({ ...request, slippageBps: 50 });
  assert.equal(buildApprovals(swap, request.amountIn).length, 0);
  const approvals = buildApprovals(swap, 1n);
  assert.deepEqual(approvals.map(p => decodeFunctionData({ abi: tokenAbi, data: p.data }).args), [[CURVE, 0n], [CURVE, request.amountIn]]);
  assert.equal(buildApprovals(swap, 0n).length, 1);
});
test("deployment verification rejects wrong chain, code, token and decimals, and accepts the reviewed bindings", async () => {
  assert.equal((await fixture().sdk.verifyDeployment()).blockNumber, 100n);
  for (const modify of [
    (c: ReturnType<typeof fixture>) => { c.state.chainId = 1; },
    (c: ReturnType<typeof fixture>) => { c.state.codes.set(CURVE, "0x"); },
    (c: ReturnType<typeof fixture>) => { c.world.quoteDecimals = 18; },
    (c: ReturnType<typeof fixture>) => { c.world.quote = addr(9); },
  ]) {
    const chain = fixture(); modify(chain);
    await assert.rejects(chain.sdk.verifyDeployment());
  }
});
test("inactive, unregistered, wrong-controller markets and unsupported pairs fail closed", async () => {
  for (const modify of [
    (c: ReturnType<typeof fixture>) => { c.world.markets.get(c.market.id.toLowerCase())!.active = false; },
    (c: ReturnType<typeof fixture>) => { c.world.deal.status = 4; },
    (c: ReturnType<typeof fixture>) => { c.world.deal.profile = 2; },
    (c: ReturnType<typeof fixture>) => { c.world.deal.controller = addr(6); },
  ]) {
    const chain = fixture(); modify(chain);
    await assert.rejects(chain.sdk.quote(chain.request), /active, registered/);
  }
  const { sdk, request } = fixture();
  await assert.rejects(sdk.quote({ ...request, tokenOut: addr(10) }), /pair/);
  await assert.rejects(sdk.quote({ ...request, tokenIn: request.tokenOut, tokenOut: request.tokenOut }), /pair/);
});
test("paused buys are rejected while sells remain available", async () => {
  const { sdk, request, world } = fixture();
  const sell = { ...request, tokenIn: request.tokenOut, tokenOut: request.tokenIn };
  world.paused = true;
  await assert.rejects(sdk.quote(request), /BuysPaused/);
  assert.equal((await sdk.quote(sell)).side, "sell");
});
test("batch sampling preserves order and distinguishes failed samples from zero prices", async () => {
  const { sdk, request, state } = fixture();
  const { results } = await sdk.quoteMany([request, { ...request, tokenOut: addr(9) }, request]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(state.calls.filter(call => call.functionName === "market").length, 1);
});
test("reorg during reads rejects the quote and discovery results", async () => {
  const { sdk, request, state } = fixture();
  state.reorg = true;
  await assert.rejects(sdk.quote(request), /changed/);
  await assert.rejects(sdk.discoverMarkets(), /changed/);
});
test("discovery validates market state, resumes a canonical cursor and rejects cross-release cursors", async () => {
  const { sdk, state, world, market } = fixture();
  world.logs = [{ removed: false, args: { dealId: market.id } }];
  const page = await sdk.discoverMarkets({ pageSize: 1000 });
  assert.equal(page.markets[0]?.id, market.id); assert.equal(page.hasMore, false);
  assert.deepEqual(page.markets[0], { id: market.id, coin: market.coin, coinDecimals: 18, creator: addr(7), activatedAt: 100n, quoteToken: addr(3), curve: CURVE });
  // The event filter is the compiled curve's MarketActivated, so its topic is the one the live curve emits.
  const [request] = world.logRequests, compiled = getAbiItem({ abi: full("curve"), name: "MarketActivated" });
  assert.equal(request!.address, CURVE); assert.equal(toEventSelector(request!.event as AbiEvent), toEventSelector(compiled as AbiEvent));
  const empty = await sdk.discoverMarkets({ cursor: page.cursor });
  assert.equal(empty.markets.length, 0); assert.equal(world.logCalls, 1);
  await assert.rejects(sdk.discoverMarkets({ cursor: { ...page.cursor, releaseId: "other" } }), /Cursor/);
  state.reorg = true;
  await assert.rejects(sdk.discoverMarkets({ cursor: page.cursor }), /reorganized/);
});
test("simulation requires real balance/approval and rejects stale price, expiry and altered calldata", async () => {
  const { sdk, state, request, world, holdings } = fixture();
  holdings(2_000_000n, 0n);
  const swap = await sdk.prepareSwap({ ...request, slippageBps: 50 });
  assert.equal((await sdk.checkSwap(swap)).approvals.length, 1);
  await assert.rejects(sdk.checkSwap(swap, true), /approvals/);
  holdings(2_000_000n, request.amountIn);
  assert.equal((await sdk.checkSwap(swap, true)).gas, 200_000n);
  assert.deepEqual(state.simulations.map(call => [call.to, call.account]), [[CURVE, request.caller]]);
  holdings(0n, request.amountIn); await assert.rejects(sdk.checkSwap(swap, true), /input tokens/);
  holdings(request.amountIn, request.amountIn);
  await assert.rejects(sdk.checkSwap({ ...swap, transaction: { ...swap.transaction, data: "0xdeadbeef" } }), /does not match/);
  world.buy = { out: 1n, fee: 20_000n }; await assert.rejects(sdk.checkSwap(swap), /below/);
  world.buy = { out: 900_000n, fee: 20_000n }; state.timestamp = 1301n; await assert.rejects(sdk.checkSwap(swap), /expired/);
  await assert.rejects(sdk.checkSwap({ ...swap, quote: { ...swap.quote, releaseId: "elsewhere" } }), /another deployment/);
});
test("integer boundaries, zero minimum, deadlines, proportions and zero callers are rejected", async () => {
  const { sdk, request } = fixture();
  for (const amount of [0n, -1n, 2n ** 256n]) await assert.rejects(sdk.quote({ ...request, amountIn: amount }), /bigint/);
  await assert.rejects(sdk.quote({ ...request, caller: addr(0) }), /nonzero/);
  assert.throws(() => minimumAmountOut(1n, 1), /zero/);
  assert.throws(() => minimumAmountOut(100n, 10_000), /Slippage/);
  const quote = await sdk.quote(request);
  assert.throws(() => buildSwap(quote, { slippageBps: 1, deadline: quote.timestamp }), /later/);
  const swap = buildSwap(quote, { slippageBps: 0, deadline: 1100n });
  assert.throws(() => buildZeroExBasic(swap, 1_000_001), /ppm/);
  await assert.rejects(sdk.prepareSwap({ ...request, slippageBps: 1, ttlSeconds: 0 }), /lifetime/);
});
test("the bundled deployment builds a client without any further configuration", () => {
  const chain = createWorld();
  assert.equal(createOxleyClient({ publicClient: chain.rpc, deployment: testnetDeployment }).deployment.releaseId, testnetDeployment.releaseId);
});
