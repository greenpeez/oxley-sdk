import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyClient, openingSurchargeWadAt, openingFeeCurveAbi, testnetDeployment } from "../src/index.js";
import { createOxleyAuctionClient } from "../src/auctions.js";

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
const sdk = createOxleyClient({ publicClient, deployment: testnetDeployment });
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const holder = "0x1111111111111111111111111111111111111111" as Address, recipient = "0x2222222222222222222222222222222222222222" as Address;

const verified = await sdk.verifyDeployment();
console.log(json({ verified: { releaseId: verified.deployment.releaseId, blockNumber: verified.blockNumber } }));

// The pure surcharge schedule must equal what the curve computes on chain.
for (let elapsed = 0; elapsed <= 70; elapsed += 5) {
  const onChain = await publicClient.readContract({ address: testnetDeployment.curve.address as Address, abi: openingFeeCurveAbi, functionName: "surchargeWadAt", args: [BigInt(elapsed)] });
  assert.equal(openingSurchargeWadAt(elapsed), onChain, `surcharge at ${elapsed}s`);
}

// Auction graph: pins, router/adapter/hook/exposure bindings, compiled bid rules, floor cap and minimum raise, without needing a live auction.
const graph = await createOxleyAuctionClient({ publicClient, deployment: testnetDeployment }).verifyDeployment();
console.log(json({ auctionGraphVerified: true, releaseId: graph.deployment.releaseId, blockNumber: graph.blockNumber }));

// A live market is optional: set OXLEY_MARKET_ID to an activated market to quote it and prepare fee batches.
const id = process.env.OXLEY_MARKET_ID as Hex | undefined;
if (!id) console.log(json({ market: "skipped; set OXLEY_MARKET_ID to an activated market" }));
else {
  const { market } = await sdk.getMarket(id);
  const status = await sdk.getTradingStatus(id);
  const buy = await sdk.quote({ marketId: id, tokenIn: market.quoteToken, tokenOut: market.coin, amountIn: 10_000_000n, caller: holder });
  // The quote must carry the curve's real fee; buys report the opening surcharge rate.
  assert.ok(buy.amountOut > 0n && buy.feeAmount >= 200_000n, "buy fee covers at least the standard 2%");
  const prepared = await sdk.prepareSwapWithFee({ marketId: id, tokenIn: market.quoteToken, tokenOut: market.coin, amountIn: 10_000_000n,
    caller: holder, slippageBps: 100, feeRecipient: recipient, feeBps: 50 });
  assert.equal(prepared.fee.amount, 50_000n); assert.equal(prepared.swap.quote.amountIn, 9_950_000n);
  const checked = await sdk.checkSwapWithFee(prepared);
  assert.equal(checked.calls.at(-1)?.kind, "trade"); assert.equal(checked.sufficientBalance, false);
  // A sell sizes its fee from the guaranteed minimum output and pays it after the trade.
  const sell = await sdk.prepareSwapWithFee({ marketId: id, tokenIn: market.coin, tokenOut: market.quoteToken, amountIn: 10n ** 17n,
    caller: holder, slippageBps: 100, feeRecipient: recipient, feeBps: 50 });
  assert.equal(sell.fee.amount, sell.fee.basisAmount * 50n / 10_000n); assert.equal(sell.fee.basisAmount, sell.swap.minAmountOut);
  assert.equal(sell.calls.at(sell.fee.amount > 0n ? -1 : -2)?.kind, sell.fee.amount > 0n ? "fee-transfer" : "trade");
  assert.equal(sell.receive.minimum, sell.swap.minAmountOut - sell.fee.amount);
  await sdk.checkSwapWithFee(sell);
  const terms = await sdk.getTermsStatus(holder);
  console.log(json({ id, tradingOpen: status.open, fallbackAt: status.fallbackAt,
    buyQuote: { amountIn: buy.amountIn, amountOut: buy.amountOut, feeAmount: buy.feeAmount, openingSurchargeWad: buy.openingSurchargeWad },
    withFee: { net: prepared.swap.quote.amountIn, fee: prepared.fee.amount, calls: prepared.calls.map(call => call.kind) },
    sellWithFee: { coinIn: sell.spend.amount, quoteOut: sell.swap.quote.amountOut, minimum: sell.swap.minAmountOut, fee: sell.fee.amount,
      receiveMinimum: sell.receive.minimum, calls: sell.calls.map(call => call.kind) },
    terms: { enforced: terms.enforced, accepted: terms.accepted, requiredVersion: terms.requiredVersion } }));
}
