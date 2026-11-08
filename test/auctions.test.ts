import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import { buildAuctionBidApprovals, buildAuctionClaim, buildAuctionRefund, ccaAuctionAbi, createOxleyAuctionClient } from "../src/auctions.js";
import { tokenAbi } from "../src/abis.js";
import { OxleyError } from "../src/index.js";
import { addr, full, id32, manifest } from "./support/chain.js";
import { auction, createAuctionWorld, dealId, owner, ROUTER, type AuctionWorld } from "./support/auction.js";

const caller = addr(10);
const recoveryArgs = { chainId: 31337, auction, bidId: 0n };

test("claim and both refund paths encode the actual contract selectors", () => {
  const cca = full("cca-auction");
  const claim = buildAuctionClaim(recoveryArgs), refund = buildAuctionRefund(recoveryArgs);
  assert.equal(claim.to, auction); assert.equal(refund.to, auction); assert.equal(claim.value, 0n);
  assert.equal(decodeFunctionData({ abi: cca, data: claim.data }).functionName, "claimTokens");
  assert.equal(decodeFunctionData({ abi: cca, data: refund.data }).functionName, "exitBid");
  assert.deepEqual(decodeFunctionData({ abi: cca, data: refund.data }).args, [0n]);
  const partial = buildAuctionRefund({ ...recoveryArgs, partialFill: { lastFullyFilledCheckpointBlock: 10n, outbidBlock: 0n } });
  assert.equal(decodeFunctionData({ abi: cca, data: partial.data }).functionName, "exitPartiallyFilledBid");
  assert.deepEqual(decodeFunctionData({ abi: cca, data: partial.data }).args, [0n, 10n, 0n]);
});
test("bigint widths, bid IDs, hints and malformed identities fail closed", () => {
  for (const bidId of [-1n, 1n << 256n, 1, "1"]) {
    assert.throws(() => buildAuctionClaim({ ...recoveryArgs, bidId: bidId as bigint }));
    assert.throws(() => buildAuctionRefund({ ...recoveryArgs, bidId: bidId as bigint }));
  }
  assert.doesNotThrow(() => buildAuctionClaim({ ...recoveryArgs, bidId: 0n }));
  for (const hint of [-1n, 1n << 64n, 1, "1"]) assert.throws(() => buildAuctionRefund({ ...recoveryArgs,
    partialFill: { lastFullyFilledCheckpointBlock: hint as bigint, outbidBlock: 0n } }));
  assert.throws(() => buildAuctionRefund({ ...recoveryArgs, partialFill: { lastFullyFilledCheckpointBlock: 1n, outbidBlock: 1n << 64n } }));
  assert.throws(() => buildAuctionClaim({ ...recoveryArgs, chainId: 1.5 }));
  assert.throws(() => buildAuctionClaim({ ...recoveryArgs, auction: addr(0) }));
  assert.throws(() => buildAuctionRefund({ ...recoveryArgs, auction: addr(0) }));
});
test("approvals cover total debit and reset nonzero insufficient allowances", () => {
  const args = { chainId: 31337, quoteToken: addr(3), bidRouter: addr(5), debit: 100_100_000n };
  const list = buildAuctionBidApprovals({ ...args, currentAllowance: 100_000_000n });
  assert.deepEqual(list.map(tx => decodeFunctionData({ abi: tokenAbi, data: tx.data }).args),
    [[addr(5), 0n], [addr(5), args.debit]]);
  assert.equal(buildAuctionBidApprovals({ ...args, currentAllowance: 0n }).length, 1);
  assert.equal(buildAuctionBidApprovals({ ...args, currentAllowance: args.debit }).length, 0);
  for (const bad of [{ debit: 0n }, { quoteToken: addr(0) }, { bidRouter: addr(0) }, { currentAllowance: -1n }]) {
    assert.throws(() => buildAuctionBidApprovals({ ...args, currentAllowance: 0n, ...bad }));
  }
});

/** A finished auction with bid 0 owned by `owner`; the caller is a third party. */
const finished = (patch: Partial<{ exitedBlock: bigint; tokensFilled: bigint }> = {}) => {
  const chain = createAuctionWorld();
  chain.world.bids.set(0n, { id: 0n, owner, maxPrice: 2000n, startBlock: 10n, amountQ96: 50_000_000n << 96n, exitedBlock: 0n, tokensFilled: 10n, ...patch });
  return chain;
};
const request = { dealId, bidId: 0n, caller };
test("refunds and claims preserve the original owner even when a third party submits, and need the exit first", async () => {
  const chain = finished(), client = chain.client();
  const refund = await client.prepareRefund(request);
  assert.equal(refund.owner, owner); assert.equal(refund.transaction.to, auction); assert.equal(refund.simulated, true);
  assert.deepEqual(chain.state.simulations.map(call => [call.to, call.account]), [[auction, caller]]);
  await assert.rejects(client.prepareClaim(request), /Exit first/);
  chain.world.bids.get(0n)!.exitedBlock = 200n;
  await assert.rejects(client.prepareRefund(request), /already exited/);
  const claim = await client.prepareClaim(request);
  assert.equal(claim.owner, owner); assert.equal(decodeFunctionData({ abi: ccaAuctionAbi, data: claim.transaction.data }).functionName, "claimTokens");
  chain.world.bids.get(0n)!.tokensFilled = 0n; await assert.rejects(client.prepareClaim(request), /no unclaimed/);
});
test("partial refund hints stay explicit and failed simulations propagate", async () => {
  const chain = finished(), client = chain.client();
  const partialFill = { lastFullyFilledCheckpointBlock: 123n, outbidBlock: 124n };
  const result = await client.prepareRefund({ ...request, partialFill });
  assert.deepEqual(decodeFunctionData({ abi: ccaAuctionAbi, data: result.transaction.data }).args, [0n, 123n, 124n]);
  await assert.rejects(client.prepareRefund({ ...request, partialFill: { lastFullyFilledCheckpointBlock: 1n << 64n, outbidBlock: 0n } }));
  chain.world.callError = new Error("contract revert");
  await assert.rejects(client.prepareRefund(request), /contract revert/);
  await assert.rejects(client.prepareRefund({ ...request, partialFill }), /contract revert/);
});
test("recovery inputs are validated before any read and a bid owner of zero is refused", async () => {
  const chain = finished(), client = chain.client();
  for (const bad of [{ bidId: -1n }, { caller: addr(0) }, { dealId: "0x00" as `0x${string}` }]) {
    const before = chain.world.reads.length;
    await assert.rejects(client.prepareRefund({ ...request, ...bad }));
    assert.equal(chain.world.reads.length, before, "nothing is read for invalid input");
  }
  chain.world.bids.get(0n)!.owner = addr(0);
  await assert.rejects(client.prepareRefund(request));
});
test("an auction that does not belong to the reviewed deployment cannot produce transactions", async () => {
  const cases: [string, (chain: AuctionWorld) => void][] = [
    ["another profile", chain => { chain.world.deal.profile = 2; }],
    ["another controller", chain => { chain.world.deal.controller = addr(99); }],
    ["another reserve asset", chain => { chain.world.deal.reserveAsset = addr(98); }],
    ["another deal behind the campaign", chain => { chain.world.campaignDealId = id32(0xbeef); }],
  ];
  for (const [label, mutate] of cases) {
    const chain = finished(); mutate(chain);
    await assert.rejects(chain.client().prepareRefund(request), (error: unknown) => error instanceof OxleyError && error.code === "UNSUPPORTED_AUCTION", label);
    await assert.rejects(chain.client().getAuction(dealId), (error: unknown) => error instanceof OxleyError && error.code === "UNSUPPORTED_AUCTION", label);
  }
  const ready = finished();
  assert.deepEqual([await ready.client().getAuction(dealId).then(item => [item.auction, item.open, item.blockNumber])], [[auction, true, 100n]]);
});
test("a wrong chain, changed code and a reorganized observation cannot produce transactions", async () => {
  const cases: [string, (chain: AuctionWorld) => void][] = [
    ["chain", chain => { chain.state.chainId = 1; }],
    ["router code", chain => { chain.state.codes.set(ROUTER, "0x"); }],
    ["reorg", chain => { chain.state.reorg = true; }],
  ];
  for (const [label, mutate] of cases) {
    const chain = finished(); mutate(chain);
    await assert.rejects(chain.client().prepareRefund(request), label);
  }
});
test("the client takes the same reviewed manifest as the trading client and refuses a manifest without the Dynamic Bid pins", () => {
  const chain = createAuctionWorld();
  const { auctionBindings: { bidHook: _hook, ...rest } } = manifest();
  assert.throws(() => createOxleyAuctionClient({ publicClient: chain.rpc, deployment: { ...manifest(), auctionBindings: rest } }), /pins are required|Missing contract pin/);
  assert.equal(createOxleyAuctionClient({ publicClient: chain.rpc, deployment: manifest() }).deployment.auctionBindings.bidHook.address, addr(28));
});
