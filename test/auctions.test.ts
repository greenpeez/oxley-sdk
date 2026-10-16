import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { auctionControllerAbi, auctionBidRouterAbi, auctionAdapterAbi, ccaAuctionAbi,
  createOxleyAuctionClient, parseAuctionDeployment, buildAuctionBid, buildAuctionBidApprovals,
  buildAuctionClaim, buildAuctionRefund } from "../src/auctions.js";
import { tokenAbi } from "../src/abis.js";
import type { RpcClient } from "../src/types.js";

const addr = (n: number) => toHex(n, { size: 20 });
const id = toHex(1, { size: 32 });
const caller = addr(9), owner = addr(10), auction = addr(8), hook = addr(7), coin = addr(6);
const pin = (n: number) => ({ address: addr(n), runtimeCodeHash: keccak256("0x6000") });
const deployment = { schemaVersion: 1, releaseId: "test", chainId: 31337, network: "testnet", startBlock: "1",
  curve: pin(1), registry: pin(2), quoteToken: { ...pin(3), decimals: 6, symbol: "Oxy-USDC" },
  auctionController: addr(4), auctionBindings: { controllerRuntimeCodeHash: keccak256("0x6000"), bidRouter: pin(5), adapter: pin(11) } };
const input = { dealId: id, entered: 100_000_000n, maxPriceQ96: 1000n, previousTick: 100n, deadline: 2000n };
const bidArgs = { ...input, chainId: 31337, bidRouter: addr(5) };
const recoveryArgs = { chainId: 31337, auction, bidId: 0n };
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("published full ABIs and typed subsets match hash-pinned compiler artifacts", () => {
  const evidence = JSON.parse(readFileSync(new URL("../docs/auction-artifacts.json", import.meta.url), "utf8"));
  const subsets = [auctionControllerAbi, auctionBidRouterAbi, auctionAdapterAbi, ccaAuctionAbi];
  const shape = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shape);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([k, v]) => !["name", "internalType"].includes(k)
        && !(["indexed", "anonymous"].includes(k) && v === false)).map(([k, v]) => [k, shape(v)]));
    return value;
  };
  for (const [i, item] of evidence.evidence.entries()) {
    const raw = readFileSync(new URL(`../abis/${item.name}.json`, import.meta.url));
    const fixture = readFileSync(new URL(`fixtures/${item.name}.json`, import.meta.url));
    assert.equal(sha(raw), item.abiSha256); assert.equal(sha(fixture), item.fixtureSha256);
    const full = JSON.parse(raw.toString()) as Abi;
    assert.deepEqual(full, JSON.parse(fixture.toString()).abi);
    for (const entry of subsets[i]!) {
      const original = full.find(candidate => candidate.type === entry.type && "name" in candidate && candidate.name === entry.name);
      assert.ok(original, entry.name);
      assert.deepEqual(shape(original), shape(entry), entry.name);
    }
  }
});
test("bid, claim and both refund paths encode the actual contract selectors", () => {
  const router = JSON.parse(readFileSync(new URL("../abis/ElysiumCcaBidRouterVNext.json", import.meta.url), "utf8"));
  const cca = JSON.parse(readFileSync(new URL("../abis/ContinuousClearingAuction.json", import.meta.url), "utf8"));
  const bid = buildAuctionBid(bidArgs);
  assert.equal(bid.to, addr(5)); assert.equal(bid.value, 0n);
  assert.equal(bid.data, encodeFunctionData({ abi: router, functionName: "submitBid",
    args: [id, input.maxPriceQ96, input.entered, input.previousTick, input.deadline] }));
  const claim = buildAuctionClaim(recoveryArgs), refund = buildAuctionRefund(recoveryArgs);
  assert.equal(claim.to, auction); assert.equal(refund.to, auction);
  assert.equal(decodeFunctionData({ abi: cca, data: claim.data }).functionName, "claimTokens");
  assert.deepEqual(decodeFunctionData({ abi: cca, data: refund.data }).args, [0n]);
  const partial = buildAuctionRefund({ ...recoveryArgs, partialFill: { lastFullyFilledCheckpointBlock: 10n, outbidBlock: 0n } });
  assert.equal(decodeFunctionData({ abi: cca, data: partial.data }).functionName, "exitPartiallyFilledBid");
  assert.deepEqual(decodeFunctionData({ abi: cca, data: partial.data }).args, [0n, 10n, 0n]);
});
test("bigint widths, zero bid IDs, and malformed identities fail closed", () => {
  for (const entered of [0n, -1n, 1n << 128n, 1, "1"]) {
    assert.throws(() => buildAuctionBid({ ...bidArgs, entered: entered as bigint }));
  }
  assert.doesNotThrow(() => buildAuctionBid({ ...bidArgs, entered: (1n << 128n) - 1n }));
  for (const bidId of [-1n, 1n << 256n, 1, "1"]) {
    assert.throws(() => buildAuctionClaim({ ...recoveryArgs, bidId: bidId as bigint }));
    assert.throws(() => buildAuctionRefund({ ...recoveryArgs, bidId: bidId as bigint }));
  }
  for (const hint of [-1n, 1n << 64n, 1, "1"]) assert.throws(() => buildAuctionRefund({ ...recoveryArgs,
    partialFill: { lastFullyFilledCheckpointBlock: hint as bigint, outbidBlock: 0n } }));
  assert.throws(() => buildAuctionBid({ ...bidArgs, dealId: "0x00" }));
  assert.throws(() => buildAuctionBid({ ...bidArgs, bidRouter: addr(0) }));
  assert.throws(() => buildAuctionClaim({ ...recoveryArgs, chainId: 1.5 }));
  assert.throws(() => buildAuctionRefund({ ...recoveryArgs, auction: addr(0) }));
});
test("approvals cover total debit and reset nonzero insufficient allowances", () => {
  const args = { chainId: 31337, quoteToken: addr(3), bidRouter: addr(5), debit: 100_100_000n };
  const list = buildAuctionBidApprovals({ ...args, currentAllowance: 100_000_000n });
  assert.deepEqual(list.map(tx => decodeFunctionData({ abi: tokenAbi, data: tx.data }).args),
    [[addr(5), 0n], [addr(5), args.debit]]);
  assert.equal(buildAuctionBidApprovals({ ...args, currentAllowance: 0n }).length, 1);
  assert.equal(buildAuctionBidApprovals({ ...args, currentAllowance: args.debit }).length, 0);
});

function fixture() {
  const state = { chain: 31337, code: "0x6000" as Hex, reorg: false, badQuote: false,
    quoteAsset: addr(3), controller: addr(4), open: true, current: 150n, balance: 100_100_000n,
    allowance: 0n, exited: 0n, tokens: 10n, callError: false, calls: [] as Record<string, unknown>[] };
  const rpc = {
    getChainId: async () => state.chain,
    getBlock: async (args: { blockNumber?: bigint }) => ({ number: 100n, timestamp: 1000n,
      hash: toHex(state.reorg && args.blockNumber !== undefined ? 2 : 1, { size: 32 }) }),
    getCode: async () => state.code,
    readContract: async ({ functionName: f }: { functionName: string }) => {
      const values: Record<string, unknown> = {
        feeBidRouter: addr(5), ccaAdapter: addr(11), quoteAsset: state.quoteAsset, registry: addr(2),
        adapter: addr(11), controller: state.controller, validationHook: hook, decimals: 6,
        campaign: [owner, coin, id, 200n, state.open],
        deal: { creator: owner, coin, controller: state.controller, reserveAsset: addr(3), profile: 1, status: 2 },
        auctionFor: auction, token: coin, currency: addr(3), quoteBid: [100_000_000n, 100_100_000n, state.badQuote ? 0n : 100_000n],
        startBlock: 100n, endBlock: 200n, currentBlock: state.current, floorPrice: 100n, tickSpacing: 10n, MAX_BID_PRICE: 10_000n,
        balanceOf: state.balance, allowance: state.allowance,
        bids: { owner, exitedBlock: state.exited, tokensFilled: state.tokens },
      };
      assert.ok(f in values, f); return values[f];
    },
    call: async (args: Record<string, unknown>) => { state.calls.push(args); if (state.callError) throw new Error("contract revert"); return { data: "0x" }; },
  } as unknown as RpcClient;
  return { state, client: createOxleyAuctionClient({ publicClient: rpc, deployment }) };
}
test("auction manifest requires pins and never accepts mainnet placeholders", () => {
  assert.throws(() => parseAuctionDeployment({ ...deployment, auctionBindings: undefined }));
  assert.throws(() => parseAuctionDeployment({ ...deployment, auctionBindings: { ...deployment.auctionBindings, bidRouter: pin(4) } }));
  assert.throws(() => parseAuctionDeployment(JSON.parse(readFileSync(new URL("../deployments/mainnet.template.json", import.meta.url), "utf8"))));
  const parsed = parseAuctionDeployment(deployment);
  assert.ok(Object.isFrozen(parsed.auctionBindings.bidRouter));
});
test("prepareBid reports actual fee, exact approval spender and caller ownership", async () => {
  const { client } = fixture();
  const result = await client.prepareBid({ ...input, caller });
  assert.equal(result.principal, 100_000_000n); assert.equal(result.debit, 100_100_000n);
  assert.equal(result.owner, caller); assert.equal(result.transaction.to, addr(5));
  assert.equal(result.approvals.length, 1); assert.equal(result.simulated, false);
});
test("bid simulation waits for fee-inclusive balance and confirmed approvals", async () => {
  const { state, client } = fixture();
  state.balance = 100_000_000n;
  await assert.rejects(client.prepareBid({ ...input, caller, simulate: true }), /principal plus/);
  state.balance = 100_100_000n;
  await assert.rejects(client.prepareBid({ ...input, caller, simulate: true }), /approvals/);
  state.allowance = state.balance;
  assert.equal((await client.prepareBid({ ...input, caller, simulate: true })).simulated, true);
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0]?.account, caller);
  state.callError = true;
  await assert.rejects(client.prepareBid({ ...input, caller, simulate: true }), /contract revert/);
});
test("closed auctions, wrong prices, expired deadlines and inconsistent quotes are refused", async () => {
  const { state, client } = fixture();
  for (const maxPriceQ96 of [100n, 1001n, 10_010n]) await assert.rejects(client.prepareBid({ ...input, maxPriceQ96, caller }));
  await assert.rejects(client.prepareBid({ ...input, deadline: 1000n, caller }));
  state.open = false; await assert.rejects(client.prepareBid({ ...input, caller })); state.open = true;
  state.current = 200n; await assert.rejects(client.prepareBid({ ...input, caller })); state.current = 150n;
  state.badQuote = true; await assert.rejects(client.prepareBid({ ...input, caller }), /Inconsistent/);
});
test("wrong chain, code, bindings and reorganized observations cannot produce transactions", async () => {
  for (const mutate of [
    (s: ReturnType<typeof fixture>["state"]) => { s.chain = 1; },
    (s: ReturnType<typeof fixture>["state"]) => { s.code = "0x"; },
    (s: ReturnType<typeof fixture>["state"]) => { s.quoteAsset = addr(99); },
    (s: ReturnType<typeof fixture>["state"]) => { s.controller = addr(99); },
    (s: ReturnType<typeof fixture>["state"]) => { s.reorg = true; },
  ]) { const { state, client } = fixture(); mutate(state); await assert.rejects(client.prepareBid({ ...input, caller })); }
});
test("refunds and claims preserve original owner even when a third party submits", async () => {
  const { state, client } = fixture();
  const request = { dealId: id, bidId: 0n, caller };
  const refund = await client.prepareRefund(request);
  assert.equal(refund.owner, owner); assert.equal(refund.transaction.to, auction);
  await assert.rejects(client.prepareClaim(request), /Exit first/);
  state.exited = 200n;
  await assert.rejects(client.prepareRefund(request), /already exited/);
  assert.equal((await client.prepareClaim(request)).owner, owner);
  state.tokens = 0n; await assert.rejects(client.prepareClaim(request), /no unclaimed/);
});
test("partial refund hints stay explicit and failed simulations propagate", async () => {
  const { state, client } = fixture();
  const partialFill = { lastFullyFilledCheckpointBlock: 123n, outbidBlock: 124n };
  const result = await client.prepareRefund({ dealId: id, bidId: 0n, caller, partialFill });
  assert.deepEqual(decodeFunctionData({ abi: ccaAuctionAbi, data: result.transaction.data }).args, [0n, 123n, 124n]);
  state.callError = true;
  await assert.rejects(client.prepareRefund({ dealId: id, bidId: 0n, caller }), /contract revert/);
});
