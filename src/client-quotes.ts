import { curveAbi } from "./abis.js";
import { address, check, hash, sameAddress, uint } from "./validation.js";
import type { Anchor, Market, Quote, QuoteRequest } from "./types.js";
import type { ClientContext } from "./client-context.js";
import type { MarketReader } from "./client-market.js";

export function createQuoteReader(context: ClientContext, marketReader: MarketReader) {
  const { rpc, deployment, snapshot, assertCanonical, ensureVerified } = context;
  const { tradableMarketAt } = marketReader;
  async function quoteAt(request: QuoteRequest, anchor: Anchor, markets?: Map<string, Promise<Market>>): Promise<Quote> {
    uint(request.amountIn); address(request.caller); address(request.tokenIn); address(request.tokenOut);
    hash(request.marketId);
    const key = request.marketId.toLowerCase();
    const pendingMarket = markets?.get(key) ?? tradableMarketAt(request.marketId, anchor);
    markets?.set(key, pendingMarket);
    const market = await pendingMarket;
    const buy = sameAddress(request.tokenIn, market.quoteToken) && sameAddress(request.tokenOut, market.coin);
    const sell = sameAddress(request.tokenIn, market.coin) && sameAddress(request.tokenOut, market.quoteToken);
    check(buy || sell, "UNSUPPORTED_PAIR", "Only the market coin/USDC pair is supported");
    let amountOut: bigint;
    let feeAmount: bigint;
    if (buy) {
      [amountOut, feeAmount] = await rpc.readContract({ address: market.curve, abi: curveAbi, functionName: "quoteBuy",
        args: [market.id, request.amountIn, request.caller], blockNumber: anchor.blockNumber });
    } else {
      let collateralOut: bigint;
      [amountOut, collateralOut, feeAmount] = await rpc.readContract({ address: market.curve, abi: curveAbi, functionName: "quoteSell",
        args: [market.id, request.amountIn, request.caller], blockNumber: anchor.blockNumber });
      check(collateralOut === 0n, "COLLATERAL_OUTPUT", "This sell includes a non-swap collateral redemption");
    }
    check(amountOut > 0n, "ZERO_OUTPUT", "Quote has no executable output");
    return Object.freeze({ ...anchor, chainId: deployment.chainId, releaseId: deployment.releaseId, market,
      side: buy ? "buy" : "sell", caller: request.caller, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
      amountIn: request.amountIn, amountOut, feeAmount, feeToken: market.quoteToken });
  }
  async function quote(request: QuoteRequest) {
    const anchor = await snapshot(request.blockNumber);
    await ensureVerified(anchor);
    const result = await quoteAt(request, anchor);
    await assertCanonical(anchor);
    return result;
  }
  async function quoteMany(requests: readonly Omit<QuoteRequest, "blockNumber">[], blockNumber?: bigint) {
    check(requests.length > 0 && requests.length <= 64, "BATCH_SIZE", "Quote batches support 1 to 64 samples");
    const anchor = await snapshot(blockNumber);
    await ensureVerified(anchor);
    const results: PromiseSettledResult<Quote>[] = [];
    const markets = new Map<string, Promise<Market>>();
    // Bound RPC concurrency; failures remain errors, never plausible zero-price quotes.
    for (let i = 0; i < requests.length; i += 4) {
      results.push(...await Promise.allSettled(requests.slice(i, i + 4).map(request => quoteAt(request, anchor, markets))));
    }
    await assertCanonical(anchor);
    return { ...anchor, results };
  }

  return { quoteAt, quote, quoteMany };
}
export type QuoteReader = ReturnType<typeof createQuoteReader>;
