import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { createOxleyClient, OxleyError, type Deployment, type RpcClient } from "../src/index.js";

const addr = (value: number) => toHex(value, { size: 20 });
const id = toHex(0xabcdn, { size: 32 });
const runtime = "0x60006000" as Hex;
const blockHash = toHex(456n, { size: 32 });
const pin = (value: number) => ({ address: addr(value), runtimeCodeHash: keccak256(runtime) });
const deployment: Deployment = {
  schemaVersion: 1, releaseId: "client-lifecycle", chainId: 31337, network: "testnet", startBlock: "1",
  curve: pin(1), registry: pin(2),
  quoteToken: { ...pin(3), symbol: "Oxy-USDC", decimals: 6 }, auctionController: addr(4),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const state = {
    code: runtime, codeWait: Promise.resolve(), codeReads: 0, quoteBindingReads: 0,
    marketReads: 0, marketError: undefined as Error | undefined,
    quoteWait: Promise.resolve(), quoteCalls: [] as bigint[], activeQuotes: 0, maximumQuotes: 0,
  };
  const rpc = {
    getChainId: async () => deployment.chainId,
    getBlock: async (input: { blockNumber?: bigint }) => ({
      number: input.blockNumber ?? 100n, hash: blockHash, timestamp: 1000n,
    }),
    getCode: async (input: { blockNumber: bigint }) => {
      assert.equal(input.blockNumber, 100n);
      state.codeReads++;
      await state.codeWait;
      return state.code;
    },
    getLogs: async () => [{ removed: false, args: { dealId: id } }],
    readContract: async (input: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber: bigint }) => {
      assert.equal(input.blockNumber, 100n);
      switch (input.functionName) {
        case "quoteAsset": state.quoteBindingReads++; return addr(3);
        case "decimals": return input.address === addr(3) ? 6 : 18;
        case "deal": return { creator: addr(7), coin: addr(5), controller: addr(4), reserveAsset: addr(3), profile: 1, status: 3 };
        case "market":
          state.marketReads++;
          if (state.marketError) throw state.marketError;
          return { active: true, creator: addr(7), coin: addr(5), reserveAsset: addr(3), activatedAt: 100n };
        case "quoteBuy": {
          assert.ok(input.args);
          const amount = input.args[1];
          assert.ok(typeof amount === "bigint");
          state.quoteCalls.push(amount);
          state.activeQuotes++;
          state.maximumQuotes = Math.max(state.maximumQuotes, state.activeQuotes);
          try {
            await state.quoteWait;
            return [amount * 2n, 1n];
          } finally { state.activeQuotes--; }
        }
        case "balanceOf": return 2_000_000n;
        case "allowance": return 0n;
        default: throw new Error(`Unexpected read ${input.functionName}`);
      }
    },
  } as unknown as RpcClient;
  const request = { marketId: id, tokenIn: addr(3), tokenOut: addr(5), amountIn: 1_000_000n, caller: addr(8) };
  return { state, request, sdk: createOxleyClient({ publicClient: rpc, deployment }) };
}

test("concurrent client operations share verification, retain it across methods and allow explicit rechecks", async () => {
  const { state, request, sdk } = fixture();
  const gate = deferred();
  state.codeWait = gate.promise;
  const operations = Promise.all([
    sdk.quote(request), sdk.getMarket(id), sdk.getTradingStatus(id), sdk.discoverMarkets(),
  ]);
  try {
    await setImmediate();
    assert.equal(state.codeReads, 3);
    assert.equal(state.marketReads, 0);
  } finally { gate.resolve(); }
  await operations;
  assert.equal(state.quoteBindingReads, 1);
  const swap = await sdk.prepareSwap({ ...request, slippageBps: 50 });
  await sdk.checkSwap(swap);
  await sdk.quoteMany([request]);
  assert.equal(state.codeReads, 3);
  await sdk.verifyDeployment();
  assert.equal(state.codeReads, 6);
  assert.equal(state.quoteBindingReads, 2);
  await sdk.quote(request);
  assert.equal(state.codeReads, 6);
});

test("failed shared verification rejects every observer and is retried on the next operation", async () => {
  const { state, request, sdk } = fixture();
  state.code = "0x";
  const failed = await Promise.allSettled([sdk.quote(request), sdk.getMarket(id), sdk.getTradingStatus(id)]);
  for (const result of failed) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof OxleyError);
      assert.equal(result.reason.code, "CODE_MISMATCH");
    }
  }
  assert.equal(state.codeReads, 3);
  assert.equal(state.marketReads, 0);
  state.code = runtime;
  await sdk.getMarket(id);
  await sdk.quote(request);
  assert.equal(state.codeReads, 6);
  assert.equal(state.quoteBindingReads, 1);
});

test("quote batches bound simultaneous quote reads to four and preserve amounts and result order", async () => {
  const { state, request, sdk } = fixture();
  const gate = deferred();
  state.quoteWait = gate.promise;
  const requests = Array.from({ length: 9 }, (_, index) => ({ ...request, amountIn: BigInt(index + 1) }));
  const pending = sdk.quoteMany(requests);
  try {
    await setImmediate();
    assert.equal(state.quoteCalls.length, 4);
    assert.equal(state.maximumQuotes, 4);
  } finally { gate.resolve(); }
  const { results } = await pending;
  assert.equal(state.maximumQuotes, 4);
  assert.equal(state.marketReads, 1);
  assert.deepEqual(results.map(result => result.status === "fulfilled" ? result.value.amountOut : result.status),
    requests.map(request => request.amountIn * 2n));
  assert.deepEqual(state.quoteCalls, requests.map(request => request.amountIn));
});

test("a failed market lookup is shared across batch chunks and address casing, then retried by a new batch", async () => {
  const { state, request, sdk } = fixture();
  const failure = new Error("market RPC unavailable");
  state.marketError = failure;
  const alternateCase = `0x${id.slice(2).toUpperCase()}` as Hex;
  const requests = Array.from({ length: 6 }, (_, index) => ({ ...request, marketId: index % 2 ? alternateCase : id }));
  const failed = await sdk.quoteMany(requests);
  assert.equal(state.marketReads, 1);
  assert.equal(state.quoteCalls.length, 0);
  for (const result of failed.results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, failure);
  }
  state.marketError = undefined;
  const retried = await sdk.quoteMany([request]);
  assert.equal(retried.results[0]?.status, "fulfilled");
  assert.equal(state.marketReads, 2);
});
