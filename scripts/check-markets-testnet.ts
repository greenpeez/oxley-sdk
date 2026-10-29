import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyMarkets, openingSurchargeWadAt, openingFeeCurveAbi, testnetDeployments, OxleyError } from "../src/index.js";
import { createOxleyAuctionClient } from "../src/auctions.js";
import { gen8TestnetDeployment } from "../src/testnet-deployments.js";

// Read-only: no signer, no transaction, no state change. Paced to stay under the public RPC's rate limit.
let nextRequest = 0;
const pacedFetch: typeof fetch = async (input, init) => {
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Date.now() + wait + 250;
  await delay(wait);
  return fetch(input, init);
};
const publicClient = createPublicClient({ transport: http(process.env.OXLEY_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz",
  { timeout: 30_000, retryCount: 2, fetchFn: pacedFetch }) });
const markets = createOxleyMarkets({ publicClient });
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);

// Activated markets read from each curve's MarketActivated events on 2026-10-29: one per reviewed generation that holds markets.
const samples: { symbol: string; generation: string; id: Hex }[] = [
  { symbol: "THOR", generation: "flat-fee", id: "0x5d0dbf9d1c65cf1ffc69b7296eb43f49bfa54ae575247559c1fa6fe96b10f21e" },
  { symbol: "BEAR", generation: "gen3", id: "0xfa5d5eb5d7a7a89804a9d77e4ab7980dc7dbd10e880bc7e421932801e39dc7c6" },
  { symbol: "VT", generation: "gen3", id: "0x0cc18c02eb8ab75d907c51a84d299227f21d6fbbfc5eb8ecadea4f7bde643af5" },
];
// Gen8 holds no activated market yet (its only auction, G8TEST, failed): resolution must say so rather than guess.
const failedGen8 = "0x4fe9129adfef84f694b8d97e023aa54d286322023aeb40123c4f958661d5f5e9" as Hex;
const holder = "0x1111111111111111111111111111111111111111" as Address, recipient = "0x2222222222222222222222222222222222222222" as Address;

const verified = await markets.verifyDeployments();
assert.equal(verified.length, testnetDeployments.length);
console.log(json({ verified: verified.map(({ generation, releaseId, blockNumber }) => ({ generation, releaseId, blockNumber })) }));

for (const sample of samples) {
  const resolved = await markets.resolveMarket(sample.id);
  assert.equal(resolved.entry.generation, sample.generation, `${sample.symbol} resolves to ${sample.generation}`);
  const { market } = resolved;
  const status = await markets.getTradingStatus(sample.id);
  const buy = await markets.quote({ marketId: sample.id, tokenIn: market.quoteToken, tokenOut: market.coin, amountIn: 10_000_000n, caller: holder });
  // The quote must carry the curve's real fee; Gen3 buys report the opening surcharge rate.
  assert.ok(buy.amountOut > 0n && buy.feeAmount >= 200_000n, "buy fee covers at least the standard 2%");
  const prepared = await markets.prepareSwapWithFee({ marketId: sample.id, tokenIn: market.quoteToken, tokenOut: market.coin, amountIn: 10_000_000n,
    caller: holder, slippageBps: 100, feeRecipient: recipient, feeBps: 50 });
  assert.equal(prepared.fee.amount, 50_000n); assert.equal(prepared.swap.quote.amountIn, 9_950_000n);
  const checked = await markets.checkSwapWithFee(prepared);
  assert.equal(checked.calls.at(-1)?.kind, "trade"); assert.equal(checked.sufficientBalance, false);
  // A sell sizes its fee from the guaranteed minimum output and pays it after the trade.
  const sell = await markets.prepareSwapWithFee({ marketId: sample.id, tokenIn: market.coin, tokenOut: market.quoteToken, amountIn: 10n ** 17n,
    caller: holder, slippageBps: 100, feeRecipient: recipient, feeBps: 50 });
  assert.equal(sell.fee.amount, sell.fee.basisAmount * 50n / 10_000n); assert.equal(sell.fee.basisAmount, sell.swap.minAmountOut);
  assert.equal(sell.calls.at(sell.fee.amount > 0n ? -1 : -2)?.kind, sell.fee.amount > 0n ? "fee-transfer" : "trade");
  assert.equal(sell.receive.minimum, sell.swap.minAmountOut - sell.fee.amount);
  await markets.checkSwapWithFee(sell);
  const terms = await markets.getTermsStatus({ marketId: sample.id, account: holder });
  console.log(json({ symbol: sample.symbol, generation: resolved.entry.generation, id: sample.id, tradingOpen: status.open, fallbackAt: status.fallbackAt,
    buyQuote: { amountIn: buy.amountIn, amountOut: buy.amountOut, feeAmount: buy.feeAmount, openingSurchargeWad: buy.openingSurchargeWad },
    withFee: { net: prepared.swap.quote.amountIn, fee: prepared.fee.amount, calls: prepared.calls.map(call => call.kind) },
    sellWithFee: { coinIn: sell.spend.amount, quoteOut: sell.swap.quote.amountOut, minimum: sell.swap.minAmountOut, fee: sell.fee.amount,
      receiveMinimum: sell.receive.minimum, calls: sell.calls.map(call => call.kind) },
    terms: { enforced: terms.enforced, accepted: terms.accepted, requiredVersion: terms.requiredVersion } }));
}

const missing = await markets.resolveMarket(failedGen8).catch((error: unknown) => error);
assert.ok(missing instanceof OxleyError && missing.code === "UNSUPPORTED_MARKET", "a failed Gen8 auction is not a market");

// The pure schedule must equal what both curves compute on chain.
for (const generation of ["gen3", "gen8"]) {
  const entry = markets.generations.find(item => item.generation === generation)!;
  for (let elapsed = 0; elapsed <= 70; elapsed += 5) {
    const onChain = await publicClient.readContract({ address: entry.curve, abi: openingFeeCurveAbi, functionName: "surchargeWadAt", args: [BigInt(elapsed)] });
    assert.equal(openingSurchargeWadAt(elapsed), onChain, `${generation} surcharge at ${elapsed}s`);
  }
}

// Gen8 auction graph: pins, router/adapter/hook/exposure bindings and compiled bid rules, without needing a live auction.
const auctions = createOxleyAuctionClient({ publicClient, deployment: gen8TestnetDeployment });
const graph = await auctions.verifyDeployment();
console.log(json({ gen8AuctionGraphVerified: true, releaseId: graph.deployment.releaseId, blockNumber: graph.blockNumber }));
