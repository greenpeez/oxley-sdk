import { createClientContext } from "./client-context.js";
import { createMarketReader } from "./client-market.js";
import { createQuoteReader } from "./client-quotes.js";
import { createDiscoveryReader } from "./client-discovery.js";
import { createSwapPreparer } from "./client-swaps.js";
import { parseDeployment } from "./validation.js";
import type { RpcClient } from "./types.js";

export function createOxleyClient(options: { publicClient: RpcClient; deployment: unknown }) {
  const deployment = parseDeployment(options.deployment);
  const context = createClientContext(options.publicClient, deployment);
  const { verifyDeployment } = context;
  const markets = createMarketReader(context);
  const { getMarket, getTradingStatus } = markets;
  const quotes = createQuoteReader(context, markets);
  const { quote, quoteMany } = quotes;
  const discoverMarkets = createDiscoveryReader(context, markets);
  const { prepareSwap, checkSwap } = createSwapPreparer(context, quotes);
  return { deployment, verifyDeployment, getMarket, getTradingStatus, quote, quoteMany, discoverMarkets, prepareSwap, checkSwap };
}
