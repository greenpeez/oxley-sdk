import type { Address } from "viem";
import type { OxleyClient } from "./client.js";
import type { DiscoveryCursor, Market } from "./types.js";

type Page = Awaited<ReturnType<OxleyClient["discoverMarkets"]>>;
interface Source { readonly releaseId: string; readonly client: OxleyClient }
export interface MarketsDiscoveryOptions {
  /** Resume cursors by release ID, from a previous page's `cursors`. */
  cursors?: Readonly<Record<string, DiscoveryCursor>>; fromBlock?: bigint; toBlock?: bigint; pageSize?: number; coin?: Address;
}

/**
 * One discovery page per generation, concurrently. Each generation scans its own curve's `MarketActivated` events from its
 * start block, `pageSize` blocks at a time (at most 10,000), so a full history takes many pages: persist `cursors` and loop while
 * `hasMore`. For catalogs shown to people prefer the indexed data API and resolve the chosen deal ID with `resolveMarket`.
 */
export function createMarketDiscovery(sources: readonly Source[]) {
  return async function discoverMarkets(options: MarketsDiscoveryOptions = {}) {
    const pages = await Promise.all(sources.map(async ({ releaseId, client }) => {
      const cursor = options.cursors?.[releaseId];
      const page = await client.discoverMarkets({ cursor, fromBlock: cursor ? undefined : options.fromBlock,
        toBlock: options.toBlock, pageSize: options.pageSize, coin: options.coin });
      return [releaseId, page] as const;
    }));
    const byRelease: Record<string, Page> = Object.fromEntries(pages);
    const cursors: Record<string, DiscoveryCursor> = Object.fromEntries(pages.map(([id, page]) => [id, page.cursor]));
    const markets: Market[] = pages.flatMap(([, page]) => page.markets);
    return { pages: byRelease, cursors, markets, hasMore: pages.some(([, page]) => page.hasMore) };
  };
}
