import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, createWalletClient, http, keccak256, maxUint256, parseEventLogs, toHex,
  zeroAddress, type Abi, type Address, type Hex } from "viem";
import { anvil } from "viem/chains";
import { createOxleyClient, curveAbi, tokenAbi, type Swap } from "../../src/index.js";
import { buildZeroExBasic } from "../../src/zero-ex.js";

interface Artifact { abi: Abi; bytecode: Hex }
interface Contract { address: Address; abi: Abi }
const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

// All scenarios share one isolated chain and its cleanup lifecycle.
// eslint-disable-next-line max-lines-per-function
test("SDK settles against real VNext bytecode and unmodified upstream BASIC", { timeout: 120_000 }, async t => {
  assert.ok(process.env.ANVIL_BIN, "Set ANVIL_BIN to Anvil v1.7.1; no remote or funded RPC is used");
  const port = await new Promise<number>(resolve => {
    const server = createServer(); server.listen(0, "127.0.0.1", () => {
      const info = server.address(); assert.ok(info && typeof info === "object");
      server.close(() => resolve(info.port));
    });
  });
  const child = spawn(process.env.ANVIL_BIN, ["--port", String(port), "--host", "127.0.0.1", "--chain-id", "31337", "--hardfork", "osaka", "--silent"], { stdio: "ignore" });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); } });
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, timeout: 3000 });
  const publicClient = createPublicClient({ chain: anvil, transport, pollingInterval: 10 });
  const wallet = createWalletClient({ chain: anvil, transport, pollingInterval: 10 });
  for (let attempt = 0; ; attempt++) {
    try { await publicClient.getChainId(); break; } catch (error) { if (attempt >= 40) throw error; await delay(50); }
  }
  const accounts = await wallet.getAddresses();
  const owner = accounts[0]!; const trader = accounts[1]!; const treasury = accounts[2]!; const recipient = accounts[3]!;
  async function confirmed(hash: Hex) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "local transaction reverted"); return receipt;
  }
  async function deploy(name: string, args: readonly unknown[] = []): Promise<Contract> {
    const a = await artifact(name);
    const receipt = await confirmed(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: owner }));
    assert.ok(receipt.contractAddress); return { address: receipt.contractAddress, abi: a.abi };
  }
  async function write(contract: Contract, functionName: string, args: readonly unknown[], account = owner) {
    return confirmed(await wallet.writeContract({ ...contract, functionName, args, account, gas: 12_000_000n }));
  }
  const quote = await deploy("IntegrationToken", [6]);
  const coin = await deploy("IntegrationToken", [18]);
  const secondCoin = await deploy("IntegrationToken", [18]);
  const reserve = await deploy("IntegrationReserve");
  const price = await deploy("IntegrationPrice");
  const rebate = await deploy("IntegrationRebate");
  const fees = await deploy("ElysiumFeeRouterVNext", [owner, treasury, quote.address]);
  const curve = await deploy("ElysiumReserveCurveVNext", [quote.address, reserve.address, price.address, fees.address, rebate.address, owner, owner, 3600n]);
  const listing = await deploy("ElysiumListingVault", [owner, fees.address]);
  const entry = await deploy("ElysiumEntryController", [owner]);
  const registry = await deploy("ElysiumDealRegistry", [owner, entry.address]);
  const executor = await deploy("BasicExecutor");
  await write(registry, "setController", [owner, true]);
  await write(fees, "setAccrualSource", [curve.address, true]);
  await write(fees, "setListingVault", [listing.address]);
  await write(quote, "mint", [owner, 2_000_000_000_000n]);
  await write(quote, "mint", [trader, 2_000_000_000_000n]);
  await write(quote, "approve", [curve.address, maxUint256]);
  await write(curve, "setBuysPaused", [false]);
  const marketId = toHex(1n, { size: 32 }); const secondId = toHex(2n, { size: 32 });
  for (const [id, token] of [[marketId, coin], [secondId, secondCoin]] as const) {
    const block = await publicClient.getBlock();
    await write(registry, "registerDeal", [id, { creator: owner, coin: token.address, controller: owner,
      reserveAsset: quote.address, profile: 1, status: 1, createdAt: block.timestamp, activatedAt: 0n, profileDigest: toHex(1n, { size: 32 }) }]);
    await write(fees, "configureDeal", [id, owner, 0]);
    await write(fees, "configureMarket", [id, token.address, curve.address, quote.address]);
    await write(token, "mint", [owner, 1_000_000_000n * 10n ** 18n]);
    await write(token, "approve", [curve.address, maxUint256]);
    await write(curve, "activate", [id, token.address, owner, quote.address, 1_000_000_000n * 10n ** 18n,
      1_000_000_000n * 10n ** 18n, 0, 0n, 0n, 60_000_000_000n]);
    await write(registry, "setDealStatus", [id, 3, block.timestamp]);
  }
  const pin = async (address: Address) => ({ address, runtimeCodeHash: keccak256((await publicClient.getCode({ address }))!) });
  const deployment = { schemaVersion: 1 as const, releaseId: "local-real-bytecode", network: "testnet" as const,
    chainId: 31337, startBlock: "1", curve: await pin(curve.address), registry: await pin(registry.address),
    quoteToken: { ...await pin(quote.address), symbol: "Oxy-USDC" as const, decimals: 6 as const }, auctionController: owner };
  const sdk = createOxleyClient({ publicClient, deployment });
  const balance = (token: Contract, holder: Address) => publicClient.readContract({ address: token.address, abi: tokenAbi, functionName: "balanceOf", args: [holder] });
  const buyRequest = { marketId, tokenIn: quote.address, tokenOut: coin.address, amountIn: 10_000_000n, caller: trader };
  const sendSwap = async (swap: Swap) => confirmed(await wallet.sendTransaction({ ...swap.transaction, account: trader, gas: 2_000_000n }));
  async function accounting() {
    return Promise.all([
      balance(quote, trader), balance(quote, treasury), balance(quote, curve.address), balance(quote, fees.address), balance(coin, trader),
      publicClient.readContract({ ...fees, functionName: "rewardState", args: [marketId] }),
      publicClient.readContract({ ...curve, functionName: "market", args: [marketId] }),
    ]);
  }

  await t.test("runtime validation, discovery and direct buy/sell quote parity", async () => {
    await sdk.verifyDeployment();
    assert.equal((await sdk.discoverMarkets()).markets.length, 2);
    let swap = await sdk.prepareSwap({ ...buyRequest, slippageBps: 0 });
    const initial = await sdk.checkSwap(swap);
    for (const approval of initial.approvals) await confirmed(await wallet.sendTransaction({ ...approval, account: trader }));
    swap = await sdk.prepareSwap({ ...buyRequest, slippageBps: 0 });
    const simulation = await sdk.checkSwap(swap, true);
    const before = await balance(coin, trader);
    const bought = await sendSwap(swap);
    assert.equal(await balance(coin, trader) - before, swap.quote.amountOut);
    const sell = await sdk.prepareSwap({ marketId, tokenIn: coin.address, tokenOut: quote.address,
      amountIn: swap.quote.amountOut / 2n, caller: trader, slippageBps: 0 });
    for (const approval of (await sdk.checkSwap(sell)).approvals) await confirmed(await wallet.sendTransaction({ ...approval, account: trader }));
    const beforeQuote = await balance(quote, trader);
    const sold = await sendSwap(sell);
    assert.equal(await balance(quote, trader) - beforeQuote, sell.quote.amountOut);
    t.diagnostic(`direct buy gas=${bought.gasUsed}, sell gas=${sold.gasUsed}, estimate=${simulation.gas}`);
  });

  await t.test("generic BASIC returns output to recipient and records the actual curve caller", async () => {
    await write(quote, "approve", [executor.address, maxUint256], trader);
    const swap = await sdk.prepareSwap({ ...buyRequest, caller: executor.address, slippageBps: 0 });
    const before = await balance(coin, recipient);
    const receipt = await write(executor, "execute", [quote.address, swap.quote.amountIn, [buildZeroExBasic(swap).data],
      coin.address, swap.minAmountOut, recipient], trader);
    assert.equal(await balance(coin, recipient) - before, swap.quote.amountOut);
    const events = parseEventLogs({ abi: curveAbi, logs: receipt.logs, eventName: "Bought" });
    assert.equal(events[0]?.args.buyer.toLowerCase(), executor.address.toLowerCase());
    t.diagnostic(`upstream BASIC buy gas=${receipt.gasUsed}`);
  });

  await t.test("split and multihop routing compose in one transaction", async () => {
    const half = buyRequest.amountIn / 2n;
    const swap = await sdk.prepareSwap({ ...buyRequest, amountIn: half, caller: executor.address, slippageBps: 100 });
    await write(executor, "execute", [quote.address, buyRequest.amountIn,
      [buildZeroExBasic(swap, 500_000).data, buildZeroExBasic(swap).data], coin.address, swap.minAmountOut * 2n, recipient], trader);
    const held = await balance(coin, trader);
    const sell = await sdk.prepareSwap({ marketId, tokenIn: coin.address, tokenOut: quote.address,
      amountIn: held / 4n, caller: executor.address, slippageBps: 50 });
    const buyOther = await sdk.prepareSwap({ marketId: secondId, tokenIn: quote.address, tokenOut: secondCoin.address,
      amountIn: sell.quote.amountOut, caller: executor.address, slippageBps: 50 });
    await write(coin, "approve", [executor.address, sell.quote.amountIn], trader);
    await write(executor, "execute", [coin.address, sell.quote.amountIn,
      [buildZeroExBasic(sell).data, buildZeroExBasic(buyOther).data], secondCoin.address, buyOther.minAmountOut, recipient], trader);
    assert.ok(await balance(secondCoin, recipient) > 0n);
    assert.equal(await balance(quote, executor.address), 0n);
  });

  await t.test("a failed final route leg rolls back input, fees, rewards and curve state", async () => {
    const swap = await sdk.prepareSwap({ ...buyRequest, caller: executor.address, slippageBps: 0 });
    const before = await accounting();
    await assert.rejects(write(executor, "execute", [quote.address, swap.quote.amountIn, [buildZeroExBasic(swap).data],
      coin.address, swap.quote.amountOut + 1n, recipient], trader));
    assert.deepEqual(await accounting(), before);
  });

  await t.test("failed recipient transfer is atomic; treasury transfer failure defers its fee only", async () => {
    let swap = await sdk.prepareSwap({ ...buyRequest, slippageBps: 0 });
    await write(quote, "approve", [curve.address, maxUint256], trader);
    await write(coin, "reject", [trader, false]);
    const before = await accounting();
    await assert.rejects(sendSwap(swap));
    assert.deepEqual(await accounting(), before);
    await write(coin, "reject", [zeroAddress, false]);
    await write(quote, "reject", [treasury, false]);
    swap = await sdk.prepareSwap({ ...buyRequest, slippageBps: 0 });
    await sendSwap(swap);
    const pending = await publicClient.readContract({ ...fees, functionName: "pendingProtocolFees", args: [quote.address] });
    assert.ok(typeof pending === "bigint" && pending > 0n);
    await write(quote, "reject", [zeroAddress, false]);
  });

  await t.test("buy pause and deadline/slippage reverts do not prevent a permitted sell", async () => {
    const swap = await sdk.prepareSwap({ ...buyRequest, slippageBps: 0 });
    await write(curve, "setBuysPaused", [true]);
    await assert.rejects(sdk.quote(buyRequest));
    await assert.rejects(sendSwap(swap));
    const held = await balance(coin, trader);
    const sell = await sdk.prepareSwap({ marketId, tokenIn: coin.address, tokenOut: quote.address,
      amountIn: held / 10n, caller: trader, slippageBps: 0 });
    await write(coin, "approve", [curve.address, sell.quote.amountIn], trader);
    await sendSwap(sell);
    await write(curve, "setBuysPaused", [false]);
    await assert.rejects(write(curve, "buy", [marketId, buyRequest.amountIn, 1n, 1n], trader));
    await assert.rejects(write(curve, "buy", [marketId, buyRequest.amountIn, maxUint256, maxUint256], trader));
  });
});
