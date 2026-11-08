import type { Hex } from "viem";
import { registryAbi, tokenAbi } from "./abis.js";
import { tradingGateAbi } from "./curve-abis.js";
import { readCurveMarket } from "./curve.js";
import { tradingNotOpenMessage } from "./revert.js";
import { address, check, hash, OxleyError, sameAddress } from "./validation.js";
import type { Anchor, Market } from "./types.js";
import type { ClientContext } from "./client-context.js";

export function createMarketReader(context: ClientContext) {
  const { rpc, deployment, snapshot, assertCanonical, ensureVerified } = context;
  async function marketAt(id: Hex, anchor: Anchor): Promise<Market> {
    hash(id);
    const [deal, market] = await Promise.all([
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [id], blockNumber: anchor.blockNumber }),
      readCurveMarket(rpc, deployment, id, anchor.blockNumber),
    ]);
    // The curve holds no reserve asset of its own: the registry's reserve is the quote token.
    check(deal.profile === 1 && deal.status === 3 && market.active
      && sameAddress(deal.controller, deployment.auctionController)
      && sameAddress(deal.coin, market.coin) && sameAddress(deal.creator, market.creator)
      && sameAddress(deal.reserveAsset, deployment.quoteToken.address),
    "UNSUPPORTED_MARKET", "Only active, registered USDC auction markets are supported");
    address(market.coin);
    check(!sameAddress(market.coin, deployment.quoteToken.address), "UNSUPPORTED_MARKET", "Invalid market pair");
    const coinDecimals = await rpc.readContract({ address: market.coin, abi: tokenAbi, functionName: "decimals", blockNumber: anchor.blockNumber });
    check(coinDecimals === 18, "UNSUPPORTED_MARKET", "Unexpected auction coin precision");
    return Object.freeze({ id, coin: market.coin, coinDecimals, creator: market.creator,
      activatedAt: market.activatedAt, quoteToken: deployment.quoteToken.address, curve: deployment.curve.address });
  }
  /** The curve gate: closed until settlement delivery completes or its timed fallback passes. */
  async function gateAt(market: Market, anchor: Anchor) {
    const at = { address: deployment.curve.address, abi: tradingGateAbi, args: [market.id], blockNumber: anchor.blockNumber } as const;
    const [open, fallbackAt] = await Promise.all([
      rpc.readContract({ ...at, functionName: "tradingOpen" }), rpc.readContract({ ...at, functionName: "tradingFallbackAt" }),
    ]);
    check(fallbackAt > market.activatedAt && (open || anchor.timestamp < fallbackAt),
      "INVALID_TRADING_GATE", "Curve trading gate state is inconsistent");
    return { open, fallbackAt };
  }
  // Quotes stay readable on chain while the gate is closed, but a swap would revert: fail closed.
  async function tradableMarketAt(id: Hex, anchor: Anchor): Promise<Market> {
    const market = await marketAt(id, anchor);
    const { open, fallbackAt } = await gateAt(market, anchor);
    if (!open) throw new OxleyError("TRADING_NOT_OPEN", tradingNotOpenMessage(fallbackAt), { marketId: id, fallbackAt });
    return market;
  }
  async function getTradingStatus(id: Hex, blockNumber?: bigint) {
    const anchor = await snapshot(blockNumber);
    await ensureVerified(anchor);
    const market = await marketAt(id, anchor);
    const gate = await gateAt(market, anchor);
    await assertCanonical(anchor);
    return { marketId: id, ...gate, ...anchor };
  }
  async function getMarket(id: Hex, blockNumber?: bigint) {
    const anchor = await snapshot(blockNumber);
    await ensureVerified(anchor);
    const market = await marketAt(id, anchor);
    await assertCanonical(anchor);
    return { market, ...anchor };
  }

  return { marketAt, tradableMarketAt, getMarket, getTradingStatus };
}
export type MarketReader = ReturnType<typeof createMarketReader>;
