import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, type Hex } from "viem";
import { createOxleyClient, OxleyError } from "../src/index.js";
import { addr, full, manifest } from "./support/chain.js";
import { CURVE, createWorld } from "./support/world.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const caller = addr(8);
function setup() {
  const chain = createWorld(), sdk = createOxleyClient({ publicClient: chain.rpc, deployment: manifest() });
  const request = (marketId: Hex, coin: string, side: "buy" | "sell") => ({ marketId, caller, amountIn: side === "buy" ? 1_000_000n : 10n ** 18n,
    tokenIn: side === "buy" ? addr(3) : coin as `0x${string}`, tokenOut: side === "buy" ? coin as `0x${string}` : addr(3) });
  return { ...chain, sdk, request };
}

test("a market resolves on chain to the curve's market and reports the registry-verified identity", async () => {
  const { sdk, addMarket } = setup();
  const market = addMarket(1), resolved = await sdk.getMarket(market.id);
  assert.deepEqual({ ...resolved.market }, { id: market.id, coin: market.coin, coinDecimals: 18, creator: addr(7), activatedAt: 100n, quoteToken: addr(3), curve: CURVE });
  assert.ok(Object.isFrozen(resolved.market));
});
test("quotes use the curve's views and report the real fee, including the opening surcharge rate on buys", async () => {
  const { sdk, addMarket, request, world } = setup();
  world.surcharge = 90_000_000_000_000_000n; world.buy = { out: 800_000n, fee: 110_000n };
  const market = addMarket(1);
  const buy = await sdk.quote(request(market.id, market.coin, "buy"));
  assert.equal(buy.amountOut, 800_000n); assert.equal(buy.feeAmount, 110_000n); assert.equal(buy.openingSurchargeWad, 90_000_000_000_000_000n);
  const sell = await sdk.quote(request(market.id, market.coin, "sell"));
  assert.equal(sell.amountOut, 900_000n); assert.equal(sell.feeAmount, 20_000n); assert.equal(sell.openingSurchargeWad, undefined);
  assert.deepEqual(world.quoted, [{ side: "buy", amount: 1_000_000n }, { side: "sell", amount: 10n ** 18n }]);
});
test("a quote with no executable output is refused", async () => {
  const { sdk, addMarket, request, world } = setup();
  const market = addMarket(1);
  world.buy = { out: 0n, fee: 0n };
  await assert.rejects(sdk.quote(request(market.id, market.coin, "buy")), code("ZERO_OUTPUT"));
});
test("swap calldata matches the full compiled curve ABI: buy and sell both take market, amount, minimum and deadline", async () => {
  const { sdk, addMarket, request } = setup();
  const market = addMarket(1), abi = full("curve");
  const buy = await sdk.prepareSwap({ ...request(market.id, market.coin, "buy"), slippageBps: 100 });
  assert.deepEqual(decodeFunctionData({ abi, data: buy.transaction.data }).args, [market.id, 1_000_000n, 891_000n, 1300n]);
  assert.equal(buy.transaction.to, CURVE); assert.equal(buy.amountInOffset, 36);
  const sell = await sdk.prepareSwap({ ...request(market.id, market.coin, "sell"), slippageBps: 100 });
  const decoded = decodeFunctionData({ abi, data: sell.transaction.data });
  assert.equal(decoded.functionName, "sell");
  assert.deepEqual(decoded.args, [market.id, 10n ** 18n, 891_000n, 1300n]);
});
test("the curve fails closed while the trading gate is closed; the status reports the fallback time", async () => {
  const { sdk, addMarket, request, world } = setup();
  const market = addMarket(1);
  assert.deepEqual(await sdk.getTradingStatus(market.id).then(({ open, fallbackAt }) => ({ open, fallbackAt })), { open: true, fallbackAt: 1300n });
  world.open = false;
  await assert.rejects(sdk.quote(request(market.id, market.coin, "buy")), code("TRADING_NOT_OPEN"));
  await assert.rejects(sdk.prepareSwap({ ...request(market.id, market.coin, "sell"), slippageBps: 50 }), code("TRADING_NOT_OPEN"));
  const closed = await sdk.getTradingStatus(market.id);
  assert.deepEqual([closed.open, closed.fallbackAt, closed.marketId], [false, 1300n, market.id]);
  // A fallback time at or before activation, or an open gate whose fallback has not passed yet, is inconsistent.
  world.fallbackAt = 100n;
  await assert.rejects(sdk.getTradingStatus(market.id), code("INVALID_TRADING_GATE"));
  world.open = false; world.fallbackAt = 900n;
  await assert.rejects(sdk.getTradingStatus(market.id), code("INVALID_TRADING_GATE"));
});
test("an unknown or inactive market is not found, and a failed read is never reported as not found", async () => {
  const { sdk, addMarket, world } = setup();
  const inactive = addMarket(1, false);
  await assert.rejects(sdk.getMarket(inactive.id), code("UNSUPPORTED_MARKET"));
  await assert.rejects(sdk.getMarket(`0x${"ab".repeat(32)}`), code("UNSUPPORTED_MARKET"));
  await assert.rejects(sdk.getMarket(addr(1) as unknown as Hex), code("INVALID_HASH"));
  const live = addMarket(2);
  world.failures.set(`${CURVE}:market`, new Error("rpc is down"));
  await assert.rejects(sdk.getMarket(live.id), /rpc is down/);
});
test("discovery skips markets that fail validation but surfaces a failed read", async () => {
  const { sdk, addMarket, world } = setup();
  const good = addMarket(1), inactive = addMarket(2, false);
  world.logs = [good, inactive].map(item => ({ removed: false, args: { dealId: item.id } }));
  assert.deepEqual((await sdk.discoverMarkets()).markets.map(item => item.id), [good.id]);
  world.failures.set(`${CURVE}:market`, new Error("rpc is down"));
  await assert.rejects(sdk.discoverMarkets(), /rpc is down/);
});
