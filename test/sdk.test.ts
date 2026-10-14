import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { createOxleyClient, buildApprovals, buildSwap, minimumAmountOut, parseDeployment,
  curveAbi, tokenAbi, type Deployment, type RpcClient } from "../src/index.js";
import { buildZeroExBasic, zeroExBasicAbi } from "../src/zero-ex.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const id = toHex(123n, { size: 32 });
const blockHash = toHex(456n, { size: 32 });
const code = "0x60006000" as Hex;
const deployment: Deployment = {
  schemaVersion: 1, releaseId: "fixture", chainId: 31337, network: "testnet", startBlock: "1",
  curve: { address: addr(1), runtimeCodeHash: keccak256(code) },
  registry: { address: addr(2), runtimeCodeHash: keccak256(code) },
  quoteToken: { address: addr(3), runtimeCodeHash: keccak256(code), symbol: "Oxy-USDC", decimals: 6 },
  auctionController: addr(4),
};
function fixture() {
  const state = { chainId: 31337, code, active: true, status: 3, profile: 1, collateral: 0n,
    allowance: 0n, balance: 2_000_000n, output: 900_000n, timestamp: 1000n, reorg: false,
    decimals: 6, controller: addr(4), quoteAsset: addr(3), paused: false, reads: [] as string[],
    quoteCallers: [] as Address[], logCalls: 0, simulations: 0 };
  const rpc = {
    getChainId: async () => state.chainId,
    getBlock: async (p: { blockNumber?: bigint }) => ({ number: p.blockNumber ?? 100n,
      hash: state.reorg && p.blockNumber !== undefined ? toHex(999n, { size: 32 }) : blockHash, timestamp: state.timestamp }),
    getCode: async () => state.code,
    getLogs: async () => { state.logCalls++; return [{ removed: false, args: { dealId: id } }]; },
    call: async () => { state.simulations++; return { data: "0x" }; },
    estimateGas: async () => 200_000n,
    readContract: async (p: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber: bigint }) => {
      assert.equal(p.blockNumber, 100n);
      state.reads.push(p.functionName);
      switch (p.functionName) {
        case "quoteAsset": return state.quoteAsset;
        case "decimals": return p.address === addr(3) ? state.decimals : 18;
        case "deal": return { creator: addr(7), coin: addr(5), controller: state.controller,
          reserveAsset: addr(3), profile: state.profile, status: state.status };
        case "market": return { active: state.active, creator: addr(7), coin: addr(5),
          reserveAsset: addr(3), activatedAt: 100n };
        case "quoteBuy":
          assert.ok(!state.paused, "BuysPaused");
          state.quoteCallers.push(p.args![2] as Address); return [state.output, 20_000n];
        case "quoteSell":
          state.quoteCallers.push(p.args![2] as Address); return [state.output, state.collateral, 20_000n];
        case "balanceOf": return state.balance;
        case "allowance": return state.allowance;
        default: throw new Error(`Unexpected ${p.functionName}`);
      }
    },
  } as unknown as RpcClient;
  const sdk = createOxleyClient({ publicClient: rpc, deployment });
  const request = { marketId: id, tokenIn: addr(3), tokenOut: addr(5), amountIn: 1_000_000n, caller: addr(8) };
  return { sdk, request, state, rpc };
}

test("quotes are net on-chain outputs, pinned to a block, with no balance or allowance dependency", async () => {
  const { sdk, request, state } = fixture();
  state.balance = 0n;
  const quote = await sdk.quote(request);
  assert.equal(quote.amountOut, 900_000n); assert.equal(quote.feeAmount, 20_000n);
  assert.equal(quote.blockHash, blockHash); assert.equal(quote.blockNumber, 100n);
  assert.deepEqual(state.quoteCallers, [request.caller]);
  assert.ok(!state.reads.includes("balanceOf") && !state.reads.includes("allowance"));
});
test("buy and sell calldata preserve all financial protections; BASIC patches amount at byte 36", async () => {
  const { sdk, request } = fixture();
  for (const sell of [false, true]) {
    const input = sell ? { ...request, tokenIn: request.tokenOut, tokenOut: request.tokenIn } : request;
    const swap = await sdk.prepareSwap({ ...input, slippageBps: 50 });
    const decoded = decodeFunctionData({ abi: curveAbi, data: swap.transaction.data });
    assert.equal(decoded.functionName, sell ? "sell" : "buy");
    assert.deepEqual(decoded.args, sell ? [id, 1_000_000n, 895_500n, 0n, 1300n] : [id, 1_000_000n, 895_500n, 1300n]);
    const offset = 2 + swap.amountInOffset * 2;
    const patched = `${swap.transaction.data.slice(0, offset)}${toHex(250_000n, { size: 32 }).slice(2)}${swap.transaction.data.slice(offset + 64)}` as Hex;
    assert.equal(decodeFunctionData({ abi: curveAbi, data: patched }).args?.[1], 250_000n);
    const action = decodeFunctionData({ abi: zeroExBasicAbi, data: buildZeroExBasic(swap, 250_000).data });
    assert.deepEqual(action.args, [input.tokenIn, 250_000n, addr(1), 36n, swap.transaction.data]);
    assert.equal(swap.rewardBeneficiary, request.caller); assert.equal(swap.outputReceiver, request.caller);
  }
});
test("exact approvals use zero-first, never unlimited approval or the Settler as spender", async () => {
  const { sdk, request } = fixture();
  const swap = await sdk.prepareSwap({ ...request, slippageBps: 50 });
  assert.equal(buildApprovals(swap, request.amountIn).length, 0);
  const approvals = buildApprovals(swap, 1n);
  assert.deepEqual(approvals.map(p => decodeFunctionData({ abi: tokenAbi, data: p.data }).args), [[addr(1), 0n], [addr(1), request.amountIn]]);
  assert.equal(buildApprovals(swap, 0n).length, 1);
});
test("reject malformed manifests and testnet bindings labeled mainnet", () => {
  assert.throws(() => parseDeployment({ ...deployment, chainId: null }), /chain ID/);
  assert.throws(() => parseDeployment({ ...deployment, network: "mainnet" }), /USDC/);
  assert.throws(() => parseDeployment({ ...deployment, network: "mainnet", chainId: 99801,
    quoteToken: { ...deployment.quoteToken, symbol: "USDC" } }), /Testnet/);
  assert.throws(() => parseDeployment({ ...deployment, startBlock: "0x10" }), /decimal/);
  assert.throws(() => parseDeployment({ ...deployment, curve: { address: addr(0) } }), /nonzero/);
  const mainnet = parseDeployment({ ...deployment, network: "mainnet", quoteToken: { ...deployment.quoteToken, symbol: "USDC" } });
  assert.equal(mainnet.network, "mainnet");
});
test("deployment verification rejects wrong chain, code, token and decimals", async () => {
  for (const modify of [
    (s: ReturnType<typeof fixture>["state"]) => { s.chainId = 1; },
    (s: ReturnType<typeof fixture>["state"]) => { s.code = "0x"; },
    (s: ReturnType<typeof fixture>["state"]) => { s.decimals = 18; },
    (s: ReturnType<typeof fixture>["state"]) => { s.quoteAsset = addr(9); },
  ]) {
    const { sdk, state } = fixture(); modify(state);
    await assert.rejects(sdk.verifyDeployment());
  }
});
test("inactive, unregistered, wrong-controller markets and unsupported pairs fail closed", async () => {
  for (const key of ["active", "status", "profile", "controller"] as const) {
    const { sdk, request, state } = fixture();
    if (key === "active") state.active = false;
    if (key === "status") state.status = 4;
    if (key === "profile") state.profile = 2;
    if (key === "controller") state.controller = addr(6);
    await assert.rejects(sdk.quote(request), /active, registered/);
  }
  const { sdk, request } = fixture();
  await assert.rejects(sdk.quote({ ...request, tokenOut: addr(10) }), /pair/);
});
test("reject collateral-returning sells and paused buys; sells remain available during buy pauses", async () => {
  const { sdk, request, state } = fixture();
  const sell = { ...request, tokenIn: request.tokenOut, tokenOut: request.tokenIn };
  state.collateral = 1n; await assert.rejects(sdk.quote(sell), /collateral/);
  state.collateral = 0n; state.paused = true;
  await assert.rejects(sdk.quote(request), /BuysPaused/);
  assert.equal((await sdk.quote(sell)).side, "sell");
});
test("batch sampling preserves order and distinguishes failed samples from zero prices", async () => {
  const { sdk, request, state } = fixture();
  const { results } = await sdk.quoteMany([request, { ...request, tokenOut: addr(9) }, request]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(state.reads.filter(name => name === "market").length, 1);
});
test("reorg during reads rejects the quote and discovery results", async () => {
  const { sdk, request, state } = fixture();
  state.reorg = true;
  await assert.rejects(sdk.quote(request), /changed/);
  await assert.rejects(sdk.discoverMarkets(), /changed/);
});
test("discovery validates market state, resumes a canonical cursor and rejects cross-release cursors", async () => {
  const { sdk, state } = fixture();
  const page = await sdk.discoverMarkets({ pageSize: 1000 });
  assert.equal(page.markets[0]?.id, id); assert.equal(page.hasMore, false);
  const empty = await sdk.discoverMarkets({ cursor: page.cursor });
  assert.equal(empty.markets.length, 0); assert.equal(state.logCalls, 1);
  await assert.rejects(sdk.discoverMarkets({ cursor: { ...page.cursor, releaseId: "other" } }), /Cursor/);
  state.reorg = true;
  await assert.rejects(sdk.discoverMarkets({ cursor: page.cursor }), /reorganized/);
});
test("simulation requires real balance/approval and rejects stale price, expiry and altered calldata", async () => {
  const { sdk, state, request } = fixture();
  const swap = await sdk.prepareSwap({ ...request, slippageBps: 50 });
  assert.equal((await sdk.checkSwap(swap)).approvals.length, 1);
  await assert.rejects(sdk.checkSwap(swap, true), /approvals/);
  state.allowance = request.amountIn;
  assert.equal((await sdk.checkSwap(swap, true)).gas, 200_000n);
  state.balance = 0n; await assert.rejects(sdk.checkSwap(swap, true), /input tokens/);
  state.balance = request.amountIn;
  await assert.rejects(sdk.checkSwap({ ...swap, transaction: { ...swap.transaction, data: "0xdeadbeef" } }), /does not match/);
  state.output = 1n; await assert.rejects(sdk.checkSwap(swap), /below/);
  state.timestamp = 1301n; await assert.rejects(sdk.checkSwap(swap), /expired/);
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
