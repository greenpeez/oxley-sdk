import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, createWalletClient, createTestClient, http, keccak256, parseEventLogs, toHex,
  zeroAddress, type Abi, type Address, type Hex } from "viem";
import { anvil } from "viem/chains";
import { buildAuctionBid, buildAuctionBidApprovals, buildAuctionClaim, buildAuctionRefund,
  auctionBidRouterAbi, ccaAuctionAbi } from "../../src/auctions.js";
import { tokenAbi } from "../../src/abis.js";

interface Contract { address: Address; abi: Abi }
interface Artifact { abi: Abi; bytecode: Hex }
const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("auction SDK executes real bid-router and vendor CCA bytecode locally", { timeout: 180_000 }, async t => {
  assert.ok(process.env.ANVIL_BIN, "Set ANVIL_BIN; this suite never sends to a funded network");
  const port = await new Promise<number>(resolve => {
    const server = createServer(); server.listen(0, "127.0.0.1", () => {
      const info = server.address(); assert.ok(info && typeof info === "object");
      server.close(() => resolve(info.port));
    });
  });
  const child = spawn(process.env.ANVIL_BIN, ["--port", String(port), "--host", "127.0.0.1", "--chain-id", "31337", "--hardfork", "osaka", "--silent"], { stdio: "ignore" });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); } });
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 60_000 });
  const rpc = createPublicClient({ chain: anvil, transport, pollingInterval: 10 });
  const wallet = createWalletClient({ chain: anvil, transport, pollingInterval: 10 });
  const local = createTestClient({ chain: anvil, transport, mode: "anvil" });
  for (let i = 0; ; i++) { try { await rpc.getChainId(); break; } catch (e) { if (i >= 40) throw e; await delay(50); } }
  const [admin, bidder, other, treasury] = await wallet.getAddresses() as [Address, Address, Address, Address];
  const confirmed = async (hash: Hex) => {
    const receipt = await rpc.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, "success"); return receipt;
  };
  const deploy = async (name: string, args: readonly unknown[] = []): Promise<Contract> => {
    const a = await artifact(name), receipt = await confirmed(await wallet.deployContract({ ...a, args, account: admin }));
    assert.ok(receipt.contractAddress); return { address: receipt.contractAddress, abi: a.abi };
  };
  async function send(contract: Contract, functionName: string, args: readonly unknown[], account = admin) {
    return confirmed(await wallet.writeContract({ ...contract, functionName, args, account, gas: 12_000_000n }));
  }
  const balance = (token: Contract, account: Address) => rpc.readContract({ address: token.address, abi: tokenAbi, functionName: "balanceOf", args: [account] });
  const permit = JSON.parse(await readFile(new URL("../fixtures/Permit2Runtime.json", import.meta.url), "utf8"));
  assert.equal(keccak256(permit.code), "0x2cb311778aae1e57e25c84b36770ee4008be8c7f79c0d3fb4f2aa30be2626600");
  await local.setCode({ address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", bytecode: permit.code });
  // Local ArbSys clock fixture: both real adapter and CCA use their production virtual-block path.
  const arbSys = toHex(100, { size: 20 });
  await local.setCode({ address: arbSys, bytecode: "0x5f545f5260205ff3" });
  const clock = (value: bigint) => local.setStorageAt({ address: arbSys, index: toHex(0, { size: 32 }), value: toHex(value, { size: 32 }) });
  await clock(1000n);
  const quote = await deploy("IntegrationToken", [6]);
  const fees = await deploy("ElysiumFeeRouterVNext", [admin, treasury, quote.address]);
  const market = await deploy("BidMarket", [fees.address, quote.address]);
  await send(fees, "setAccrualSource", [market.address, true]);
  const factory = await deploy("ContinuousClearingAuctionFactory", [zeroAddress]);
  await send(quote, "mint", [bidder, 2_000_000n * 10n ** 6n]);
  await send(quote, "mint", [other, 2_000_000n * 10n ** 6n]);
  const fullCcaAbi = (await artifact("ContinuousClearingAuction")).abi;
  async function fixture(n: number) {
    const coin = await deploy("IntegrationToken", [18]);
    const router = await deploy("ElysiumCcaBidRouterVNext", [admin, fees.address, quote.address, 0, 1000n, 0n]);
    const hook = await rpc.readContract({ address: router.address, abi: auctionBidRouterAbi, functionName: "validationHook" });
    const adapter = await deploy("ElysiumUniswapCcaAdapter", [factory.address, quote.address, hook, admin]);
    await send(adapter, "setController", [admin]); await send(router, "bindAdapter", [adapter.address]);
    const id = toHex(n, { size: 32 });
    await send(fees, "configureDeal", [id, admin, 0]);
    await send(fees, "configureMarket", [id, coin.address, market.address, quote.address]);
    await send(fees, "configureProtocolSource", [id, 1, router.address]);
    await send(coin, "mint", [admin, 300_000_000n * 10n ** 18n]);
    await send(coin, "approve", [adapter.address, 300_000_000n * 10n ** 18n]);
    await send(adapter, "createAuction", [id, coin.address, quote.address, 300_000_000n * 10n ** 18n, 10n ** 19n, 50_000n * 10n ** 6n, admin]);
    const auction = await rpc.readContract({ ...adapter, functionName: "auctionFor", args: [id] }) as Address;
    const floor = await rpc.readContract({ address: auction, abi: ccaAuctionAbi, functionName: "floorPrice" });
    const end = await rpc.readContract({ address: auction, abi: ccaAuctionAbi, functionName: "endBlock" });
    return { id, coin, router, adapter, auction, floor, end };
  }
  const failed = await fixture(1), success = await fixture(2), partial = await fixture(3);
  await clock(1001n);
  async function bid(f: typeof failed, amount: bigint, price: bigint, account = bidder) {
    const [, debit, fee] = await rpc.readContract({ address: f.router.address, abi: auctionBidRouterAbi, functionName: "quoteBid", args: [amount] });
    const allowance = await rpc.readContract({ address: quote.address, abi: tokenAbi, functionName: "allowance", args: [account, f.router.address] });
    for (const approval of buildAuctionBidApprovals({ chainId: 31337, quoteToken: quote.address, bidRouter: f.router.address, debit, currentAllowance: allowance }))
      await confirmed(await wallet.sendTransaction({ ...approval, account }));
    const transaction = buildAuctionBid({ chainId: 31337, bidRouter: f.router.address, dealId: f.id, entered: amount,
      maxPriceQ96: price, previousTick: f.floor, deadline: (await rpc.getBlock()).timestamp + 3600n });
    const before = await balance(quote, account);
    const receipt = await confirmed(await wallet.sendTransaction({ ...transaction, account, gas: 3_000_000n }));
    const events = parseEventLogs({ abi: auctionBidRouterAbi, logs: receipt.logs, eventName: "AcceptedBidFee" });
    assert.equal(events.length, 1); const event = events[0]!.args;
    assert.equal(event.owner.toLowerCase(), account.toLowerCase());
    assert.equal(before - await balance(quote, account), debit);
    assert.equal(event.fee, fee); assert.equal(event.principal, amount);
    return { id: event.bidId, debit, fee, transaction };
  }
  const failBid = await bid(failed, 100n * 10n ** 6n, failed.floor * 100n);
  const winBid = await bid(success, 100_000n * 10n ** 6n, success.floor * 100n);
  const partialBid = await bid(partial, 150_000n * 10n ** 6n, partial.floor * 20n);
  await clock(1001n + (partial.end - 1001n) / 2n);
  await bid(partial, 200_000n * 10n ** 6n, partial.floor * 100n, other);
  await t.test("accepted bids retain owner and charge 0.1% on top; premature recovery reverts", async () => {
    assert.equal(failBid.debit, 100_100_000n); assert.equal(failBid.fee, 100_000n);
    const tx = buildAuctionRefund({ chainId: 31337, auction: failed.auction, bidId: failBid.id });
    const before = await balance(quote, bidder);
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...tx, account: other, gas: 2_000_000n })));
    assert.equal(await balance(quote, bidder), before);
  });
  await clock(partial.end + 1n);
  await t.test("failed auction refunds principal to bidder, not executor; fee is retained and replay fails", async () => {
    const tx = buildAuctionRefund({ chainId: 31337, auction: failed.auction, bidId: failBid.id });
    const before = await balance(quote, bidder), executorBefore = await balance(quote, other);
    await confirmed(await wallet.sendTransaction({ ...tx, account: other, gas: 2_000_000n }));
    assert.equal(await balance(quote, bidder) - before, 100_000_000n);
    assert.equal(await balance(quote, other), executorBefore);
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...tx, account: other, gas: 2_000_000n })));
    const claim = buildAuctionClaim({ chainId: 31337, auction: failed.auction, bidId: failBid.id });
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...claim, account: other, gas: 2_000_000n })));
  });
  await t.test("successful auction exits then claims tokens only to original owner without double payment", async () => {
    const claim = buildAuctionClaim({ chainId: 31337, auction: success.auction, bidId: winBid.id });
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...claim, account: other, gas: 2_000_000n })));
    const exit = buildAuctionRefund({ chainId: 31337, auction: success.auction, bidId: winBid.id });
    await confirmed(await wallet.sendTransaction({ ...exit, account: other, gas: 2_000_000n }));
    const state = await rpc.readContract({ address: success.auction, abi: ccaAuctionAbi, functionName: "bids", args: [winBid.id] });
    assert.ok(state.tokensFilled > 0n);
    const before = await balance(success.coin, bidder), executorBefore = await balance(success.coin, other);
    await confirmed(await wallet.sendTransaction({ ...claim, account: other, gas: 2_000_000n }));
    assert.equal(await balance(success.coin, bidder) - before, state.tokensFilled);
    assert.equal(await balance(success.coin, other), executorBefore);
    await confirmed(await wallet.sendTransaction({ ...claim, account: other, gas: 2_000_000n }));
    assert.equal(await balance(success.coin, bidder) - before, state.tokensFilled);
  });
  await t.test("partial-fill exit requires valid checkpoints and returns remaining principal before claiming", async () => {
    await send({ address: partial.auction, abi: fullCcaAbi }, "checkpoint", []);
    const bidState = await rpc.readContract({ address: partial.auction, abi: ccaAuctionAbi, functionName: "bids", args: [partialBid.id] });
    const checkpoints: { block: bigint; clearingPrice: bigint }[] = [];
    let block = await rpc.readContract({ address: partial.auction, abi: fullCcaAbi, functionName: "lastCheckpointedBlock" }) as bigint;
    while (block >= bidState.startBlock) {
      const point = await rpc.readContract({ address: partial.auction, abi: fullCcaAbi, functionName: "checkpoints", args: [block] }) as { clearingPrice: bigint; prev: bigint };
      checkpoints.unshift({ block, clearingPrice: point.clearingPrice });
      if (point.prev === 0n || point.prev >= block) break; block = point.prev;
    }
    const last = checkpoints.filter(p => p.clearingPrice < bidState.maxPrice).at(-1);
    const outbid = checkpoints.find(p => p.clearingPrice > bidState.maxPrice);
    assert.ok(last); assert.ok(checkpoints.at(-1)!.clearingPrice >= bidState.maxPrice);
    const tx = buildAuctionRefund({ chainId: 31337, auction: partial.auction, bidId: partialBid.id,
      partialFill: { lastFullyFilledCheckpointBlock: last.block, outbidBlock: outbid?.block ?? 0n } });
    const before = await balance(quote, bidder);
    const invalid = buildAuctionRefund({ chainId: 31337, auction: partial.auction, bidId: partialBid.id,
      partialFill: { lastFullyFilledCheckpointBlock: partial.end + 100n, outbidBlock: outbid?.block ?? 0n } });
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...invalid, account: other, gas: 3_000_000n })));
    assert.equal(await balance(quote, bidder), before);
    await confirmed(await wallet.sendTransaction({ ...tx, account: other, gas: 3_000_000n }));
    assert.ok(await balance(quote, bidder) > before);
    const claim = buildAuctionClaim({ chainId: 31337, auction: partial.auction, bidId: partialBid.id });
    await confirmed(await wallet.sendTransaction({ ...claim, account: other, gas: 2_000_000n }));
    assert.ok(await balance(partial.coin, bidder) > 0n);
  });
});
