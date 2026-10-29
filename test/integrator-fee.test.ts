import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, type Address } from "viem";
import { buildSwapWithFee, createOxleyClient, integratorFeeAmount, eip5792Batch, MAX_INTEGRATOR_FEE_BPS, OxleyError, tokenAbi,
  SEQUENTIAL_FEE_WARNING, type SwapWithFee } from "../src/index.js";
import { addr, BASES, full, manifest, type Generation } from "./support/chain.js";
import { createWorld } from "./support/world.js";

const caller = addr(8), recipient = addr(50);
const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const kinds = (prepared: SwapWithFee) => prepared.calls.map(call => call.kind);
function setup(generation: Generation = "gen3") {
  const chain = createWorld();
  const market = chain.addMarket(generation, 1), curve = addr(BASES[generation] + 1);
  const sdk = createOxleyClient({ publicClient: chain.rpc, deployment: manifest(generation, BASES[generation]) });
  const buy = { marketId: market.id, tokenIn: addr(3), tokenOut: market.coin, amountIn: 10_000_000n, caller, slippageBps: 100, feeRecipient: recipient, feeBps: 50 };
  const sell = { ...buy, tokenIn: market.coin, tokenOut: addr(3), amountIn: 10n ** 18n };
  const allow = (token: Address, amount: bigint) => chain.world.allowances.set(`${token}:${caller}:${curve}`, amount);
  return { ...chain, sdk, market, curve, buy, sell, allow };
}
const transfer = (data: `0x${string}`) => decodeFunctionData({ abi: tokenAbi, data });

test("a buy pays the fee first, approves exactly the net amount, then trades the net amount", async () => {
  const { sdk, buy, world, curve, market } = setup();
  const prepared = await sdk.prepareSwapWithFee(buy);
  // 10 Oxy-USDC spent: 0.05 to the integrator, 9.95 traded; the curve is quoted for the traded amount only.
  assert.deepEqual(world.quoted, [{ side: "buy", amount: 9_950_000n }]);
  assert.deepEqual(kinds(prepared), ["fee-transfer", "approve", "trade"]);
  assert.deepEqual(prepared.fee, { recipient, bps: 50, token: addr(3), amount: 50_000n, basis: "input", basisAmount: 10_000_000n });
  const [fee, approve, trade] = prepared.calls.map(call => call.transaction);
  assert.deepEqual([fee!.to, fee!.value, transfer(fee!.data).functionName, transfer(fee!.data).args], [addr(3), 0n, "transfer", [recipient, 50_000n]]);
  assert.deepEqual([approve!.to, transfer(approve!.data).args], [addr(3), [curve, 9_950_000n]]);
  const decoded = decodeFunctionData({ abi: full("ElysiumReserveCurveGen3"), data: trade!.data });
  assert.deepEqual([trade!.to, decoded.functionName, decoded.args], [curve, "buy", [market.id, 9_950_000n, 891_000n, 1300n]]);
  assert.deepEqual(prepared.spend, { token: addr(3), amount: 10_000_000n });
  assert.deepEqual(prepared.receive, { token: market.coin, expected: 900_000n, minimum: 891_000n });
  assert.equal(prepared.swap.quote.amountIn, 9_950_000n);
});
test("allowances decide the approval calls: none when sufficient, a reset first when a smaller one exists", async () => {
  const { sdk, buy, allow } = setup();
  allow(addr(3), 9_950_000n);
  assert.deepEqual(kinds(await sdk.prepareSwapWithFee(buy)), ["fee-transfer", "trade"]);
  allow(addr(3), 1n);
  const reset = await sdk.prepareSwapWithFee(buy);
  assert.deepEqual(kinds(reset), ["fee-transfer", "approve-reset", "approve", "trade"]);
  assert.deepEqual([reset.calls[1], reset.calls[2]].map(call => transfer(call!.transaction.data).args![1]), [0n, 9_950_000n]);
});
test("a sell trades first, then pays the fee computed on the guaranteed minimum output", async () => {
  const { sdk, sell, curve, market } = setup("gen8");
  const prepared = await sdk.prepareSwapWithFee(sell);
  assert.deepEqual(kinds(prepared), ["approve", "trade", "fee-transfer"]);
  // minimum = floor(900000 * 0.99) = 891000; fee = floor(891000 * 50 / 10000) = 4455, never more than the minimum can pay.
  assert.deepEqual(prepared.fee, { recipient, bps: 50, token: addr(3), amount: 4_455n, basis: "minimum-output", basisAmount: 891_000n });
  const [approve, trade, fee] = prepared.calls.map(call => call.transaction);
  assert.deepEqual([approve!.to, transfer(approve!.data).args], [market.coin, [curve, 10n ** 18n]]);
  const decoded = decodeFunctionData({ abi: full("ElysiumCurveGen8"), data: trade!.data });
  assert.deepEqual([decoded.functionName, decoded.args], ["sell", [market.id, 10n ** 18n, 891_000n, 1300n]]);
  assert.deepEqual([fee!.to, transfer(fee!.data).args], [addr(3), [recipient, 4_455n]]);
  assert.deepEqual(prepared.spend, { token: market.coin, amount: 10n ** 18n });
  assert.deepEqual(prepared.receive, { token: addr(3), expected: 895_545n, minimum: 886_545n });
  assert.ok(prepared.fee.amount <= prepared.swap.minAmountOut, "the fee is always covered by the guaranteed output");
});
test("a fee that rounds to zero omits its transfer instead of sending nothing", async () => {
  const { sdk, buy, sell, world } = setup();
  const dustBuy = await sdk.prepareSwapWithFee({ ...buy, amountIn: 5_000n, feeBps: 1 });
  assert.deepEqual([dustBuy.fee.amount, kinds(dustBuy), dustBuy.swap.quote.amountIn], [0n, ["approve", "trade"], 5_000n]);
  world.sell.out = 150n;
  const dustSell = await sdk.prepareSwapWithFee(sell);
  assert.deepEqual([dustSell.swap.minAmountOut, dustSell.fee.amount, kinds(dustSell)], [148n, 0n, ["approve", "trade"]]);
});
test("fee arithmetic floors, the cap is 100 bps and every bound is enforced", async () => {
  assert.equal(MAX_INTEGRATOR_FEE_BPS, 100);
  assert.deepEqual([integratorFeeAmount(10_000n, 1), integratorFeeAmount(9_999n, 1), integratorFeeAmount(199n, 50), integratorFeeAmount(0n, 100)], [1n, 0n, 0n, 0n]);
  assert.equal(integratorFeeAmount(1_000_000n, 100), 10_000n);
  for (const bps of [0, -1, 101, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "50" as unknown as number]) {
    assert.throws(() => integratorFeeAmount(1n, bps), code("INVALID_FEE_BPS"), String(bps));
  }
  assert.throws(() => integratorFeeAmount(-1n, 50), code("INVALID_AMOUNT"));
  const { sdk, buy } = setup();
  const capped = await sdk.prepareSwapWithFee({ ...buy, feeBps: 100 });
  assert.deepEqual([capped.fee.amount, capped.swap.quote.amountIn], [100_000n, 9_900_000n]);
  for (const feeBps of [0, 101, 50.5]) await assert.rejects(sdk.prepareSwapWithFee({ ...buy, feeBps }), code("INVALID_FEE_BPS"));
});
test("the recipient can be neither zero nor the curve, a token or any Oxley contract", async () => {
  const { sdk, buy, market } = setup();
  const { coin } = market;
  await assert.rejects(sdk.prepareSwapWithFee({ ...buy, feeRecipient: addr(0) }), code("INVALID_ADDRESS"));
  await assert.rejects(sdk.prepareSwapWithFee({ ...buy, feeRecipient: "0x1234" as Address }), code("INVALID_ADDRESS"));
  // curve 11, registry 12, quote token 3, controller 14, terms registry 15, bid router 16, adapter 17, the market's coin.
  for (const forbidden of [addr(11), addr(12), addr(3), addr(14), addr(15), addr(16), addr(17), coin]) {
    await assert.rejects(sdk.prepareSwapWithFee({ ...buy, feeRecipient: forbidden }), code("INVALID_FEE_RECIPIENT"), forbidden);
  }
  // A wallet that is also the integrator is allowed (for example when testing with one account).
  assert.equal((await sdk.prepareSwapWithFee({ ...buy, feeRecipient: caller })).fee.recipient, caller);
});
test("inputs are validated before any quote: amounts, lifetime, slippage and pair", async () => {
  const { sdk, buy, sell, world } = setup();
  for (const amountIn of [0n, -1n, 1n << 256n]) await assert.rejects(sdk.prepareSwapWithFee({ ...buy, amountIn }), code("INVALID_AMOUNT"));
  await assert.rejects(sdk.prepareSwapWithFee({ ...buy, ttlSeconds: 0 }), code("INVALID_TTL"));
  await assert.rejects(sdk.prepareSwapWithFee({ ...buy, ttlSeconds: 3601 }), code("INVALID_TTL"));
  assert.deepEqual(world.quoted, []);
  await assert.rejects(sdk.prepareSwapWithFee({ ...buy, slippageBps: 10_000 }), code("INVALID_SLIPPAGE"));
  await assert.rejects(sdk.prepareSwapWithFee({ ...sell, tokenOut: addr(150) }), code("UNSUPPORTED_PAIR"));
  await assert.rejects(sdk.prepareSwapWithFee({ ...buy, tokenOut: addr(150) }), code("UNSUPPORTED_PAIR"));
});
test("the EIP-5792 request carries the same ordered calls; the sequential fallback states its risk", async () => {
  const { sdk, buy } = setup();
  const prepared = await sdk.prepareSwapWithFee(buy), [request] = prepared.batch.params;
  assert.equal(prepared.batch.method, "wallet_sendCalls");
  assert.deepEqual([request.version, request.from, request.chainId, request.atomicRequired], ["2.0.0", caller, "0x7a69", true]);
  assert.deepEqual(request.calls, prepared.calls.map(call => ({ to: call.transaction.to, data: call.transaction.data, value: "0x0" })));
  assert.equal((await sdk.prepareSwapWithFee({ ...buy, atomicRequired: false })).batch.params[0].atomicRequired, false);
  assert.equal(prepared.sequential.atomic, false); assert.deepEqual(prepared.sequential.calls, prepared.calls);
  assert.equal(prepared.sequential.warning, SEQUENTIAL_FEE_WARNING);
  assert.match(SEQUENTIAL_FEE_WARNING, /Not atomic[\s\S]*BEFORE the trade[\s\S]*AFTER the trade/);
  assert.deepEqual(eip5792Batch(prepared.calls, caller, 99801, false).params[0].chainId, "0x185d9");
});
test("the offline builder agrees with the client and refuses a quote that is not for the traded amount", async () => {
  const { sdk, buy, sell, allow } = setup();
  allow(addr(3), 0n);
  const prepared = await sdk.prepareSwapWithFee(buy), options = { slippageBps: 100, deadline: prepared.swap.deadline, feeRecipient: recipient,
    feeBps: 50, amountIn: 10_000_000n, currentAllowance: 0n };
  const offline = buildSwapWithFee(prepared.swap.quote, options);
  assert.deepEqual(offline.calls, prepared.calls); assert.deepEqual(offline.batch, prepared.batch);
  assert.throws(() => buildSwapWithFee(prepared.swap.quote, { ...options, amountIn: 10_000_001n }), code("SWAP_MISMATCH"));
  assert.throws(() => buildSwapWithFee(prepared.swap.quote, { ...options, feeBps: 51 }), code("SWAP_MISMATCH"));
  assert.throws(() => buildSwapWithFee(prepared.swap.quote, { ...options, feeRecipient: prepared.swap.quote.market.curve }), code("INVALID_FEE_RECIPIENT"));
  assert.throws(() => buildSwapWithFee(prepared.swap.quote, { ...options, forbiddenRecipients: [recipient] }), code("INVALID_FEE_RECIPIENT"));
  const sold = await sdk.prepareSwapWithFee(sell);
  assert.throws(() => buildSwapWithFee(sold.swap.quote, { ...options, amountIn: 1n, feeBps: 50 }), code("SWAP_MISMATCH"));
});
test("checking re-quotes and re-derives every call, refusing any altered, reordered or stale batch", async () => {
  const { sdk, buy, world, allow, state } = setup();
  world.balances.set(`${addr(3)}:${caller}`, 10_000_000n);
  const prepared = await sdk.prepareSwapWithFee(buy);
  const checked = await sdk.checkSwapWithFee(prepared);
  assert.deepEqual(checked.calls, prepared.calls); assert.equal(checked.approvals.length, 1);
  assert.deepEqual([checked.sufficientBalance, checked.termsAccepted, checked.gas, checked.fee.amount], [true, true, undefined, 50_000n]);
  const tweak = (index: number, data: `0x${string}`) => ({ ...prepared, calls: prepared.calls.map((call, i) => i === index ? { ...call, transaction: { ...call.transaction, data } } : call) });
  const mismatch = (batch: SwapWithFee, index?: number) => assert.rejects(sdk.checkSwapWithFee(batch), (error: unknown) =>
    code("SWAP_MISMATCH")(error) && (index === undefined || (error as OxleyError).details?.index === index));
  await mismatch(tweak(0, "0xdeadbeef"), 0);
  await mismatch(tweak(2, "0xdeadbeef"), 2);
  await mismatch({ ...prepared, calls: [...prepared.calls].reverse() }, 0);
  await mismatch({ ...prepared, calls: prepared.calls.slice(1) });
  await mismatch({ ...prepared, sequential: { ...prepared.sequential, calls: prepared.calls.slice(0, 2) } });
  await mismatch({ ...prepared, fee: { ...prepared.fee, recipient: addr(51) } }, 0);
  await mismatch({ ...prepared, fee: { ...prepared.fee, bps: 100 } });
  await mismatch({ ...prepared, spend: { ...prepared.spend, amount: 10_000_001n } });
  const request = prepared.batch.params[0];
  await mismatch({ ...prepared, batch: { ...prepared.batch, params: [{ ...request, calls: request.calls.slice().reverse() }] } });
  // Atomicity is the integrator's preference, not a derived value: a consistent batch with either setting passes.
  const relaxed = { ...prepared, batch: eip5792Batch(prepared.calls, caller, 31337, false) };
  assert.equal((await sdk.checkSwapWithFee(relaxed)).calls.length, 3);
  await assert.rejects(sdk.checkSwapWithFee({ ...prepared, batch: undefined } as unknown as SwapWithFee), code("SWAP_MISMATCH"));
  allow(addr(3), 9_950_000n); // the allowance changed since preparing: the approval call is stale
  await mismatch(prepared, 1);
  world.buy.out = 1n; await assert.rejects(sdk.checkSwapWithFee(prepared), code("SLIPPAGE"));
  world.buy.out = 900_000n; state.timestamp = 1301n;
  await assert.rejects(sdk.checkSwapWithFee(prepared), code("EXPIRED_DEADLINE"));
});
test("checking a sell batch re-derives the fee from the guaranteed minimum, not from the current quote", async () => {
  const { sdk, sell, world } = setup();
  const prepared = await sdk.prepareSwapWithFee(sell);
  world.sell.out = 1_000_000n; // a better price must not change the fee that was fixed on the minimum
  const checked = await sdk.checkSwapWithFee(prepared);
  assert.deepEqual([checked.fee.amount, checked.fee.basisAmount], [4_455n, 891_000n]);
  assert.deepEqual(checked.calls.map(call => call.kind), ["approve", "trade", "fee-transfer"]);
});
test("simulation covers the trade only and needs funds, approvals and accepted terms first", async () => {
  const { sdk, buy, world, allow, state, curve } = setup();
  world.balances.set(`${addr(3)}:${caller}`, 10_000_000n);
  const pending = await sdk.prepareSwapWithFee(buy);
  await assert.rejects(sdk.checkSwapWithFee(pending, true), code("APPROVAL_REQUIRED"));
  allow(addr(3), 9_950_000n);
  const ready = await sdk.prepareSwapWithFee(buy);
  assert.deepEqual(kinds(ready), ["fee-transfer", "trade"]);
  const checked = await sdk.checkSwapWithFee(ready, true);
  assert.equal(checked.gas, 200_000n);
  assert.deepEqual(state.simulations.map(call => [call.to, call.account, call.data]), [[curve, caller, ready.swap.transaction.data]]);
  world.balances.set(`${addr(3)}:${caller}`, 9_999_999n);
  await assert.rejects(sdk.checkSwapWithFee(ready, true), code("INSUFFICIENT_BALANCE"));
  world.balances.set(`${addr(3)}:${caller}`, 10_000_000n);
  Object.assign(world.terms, { required: 1n, latest: 1n });
  await assert.rejects(sdk.checkSwapWithFee(ready, true), code("TERMS_NOT_ACCEPTED"));
  assert.equal((await sdk.checkSwapWithFee(ready)).termsAccepted, false);
});
test("a batch prepared for one deployment is refused by another", async () => {
  const { sdk, buy } = setup("gen3");
  const prepared = await sdk.prepareSwapWithFee(buy);
  const other = createOxleyClient({ publicClient: setup("gen8").rpc, deployment: manifest("gen8", BASES.gen8) });
  await assert.rejects(other.checkSwapWithFee(prepared), code("SWAP_MISMATCH"));
});
