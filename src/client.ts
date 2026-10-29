import { createClientContext } from "./client-context.js";
import { createMarketReader } from "./client-market.js";
import { createQuoteReader } from "./client-quotes.js";
import { createDiscoveryReader } from "./client-discovery.js";
import { createSwapChecker, createSwapPreparer } from "./client-swaps.js";
import { createFeeSwapPreparer } from "./client-fee-swaps.js";
import { createTermsReader } from "./client-terms.js";
import { parseDeployment } from "./validation.js";
import type { RpcClient } from "./types.js";

/** One client per deployment (flat-fee, Gen2, Gen3 or Gen8); `createOxleyMarkets` routes a market to the right one. */
export function createOxleyClient(options: { publicClient: RpcClient; deployment: unknown }) {
  const deployment = parseDeployment(options.deployment);
  const context = createClientContext(options.publicClient, deployment);
  const { verifyDeployment } = context;
  const markets = createMarketReader(context);
  const { getMarket, getTradingStatus } = markets;
  const quotes = createQuoteReader(context, markets);
  const { quote, quoteMany } = quotes;
  const discoverMarkets = createDiscoveryReader(context, markets);
  const terms = createTermsReader(context);
  const { getTermsStatus, prepareAcceptTerms } = terms;
  const checker = createSwapChecker(context, quotes, terms);
  const { prepareSwap, checkSwap } = createSwapPreparer(context, quotes, checker);
  const { prepareSwapWithFee, checkSwapWithFee } = createFeeSwapPreparer(context, quotes, checker);
  return { deployment, verifyDeployment, getMarket, getTradingStatus, quote, quoteMany, discoverMarkets, prepareSwap, checkSwap,
    getTermsStatus, prepareAcceptTerms, prepareSwapWithFee, checkSwapWithFee };
}
export type OxleyClient = ReturnType<typeof createOxleyClient>;
