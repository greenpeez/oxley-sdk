type Row = Record<string, unknown>;
export const object = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
export const uint = (v: unknown): v is string => typeof v === "string" && /^\d{1,85}$/.test(v);
export const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const address = (v: unknown) => typeof v === "string" && /^0x[\da-f]{40}$/i.test(v);
const hash = (v: unknown) => typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const amounts = (r: Row, keys: string[]) => keys.every(k => uint(r[k]));
const texts = (r: Row, keys: string[]) => keys.every(k => typeof r[k] === "string");
const addresses = (r: Row, keys: string[]) => keys.every(k => address(r[k]));
const quote = (r: Row) => address(r.quoteAsset) && ["USDC", "Oxy-USDC"].includes(String(r.quoteSymbol));
const market = (r: Row) => hash(r.dealId) && addresses(r, ["coin", "creator"])
  && texts(r, ["name", "symbol"]) && integer(r.launchedAt) && quote(r);
const eventAmounts: Record<string, string[]> = {
  "auction-open": ["startBlock", "endBlock", "floorQ96", "tickQ96", "targetUnits"],
  "auction-bid": ["bidId", "priceQ96", "amountUnits"],
  "auction-checkpoint": ["checkpointBlock", "clearingQ96"],
  "auction-exit": ["bidId", "tokensFilled", "refundedUnits"],
  "auction-claim": ["bidId", "tokensFilled"], "auction-sweep": ["amount"],
  "auction-settle": ["proceeds", "soldSupply", "returnedSupply", "curveSeed", "platformAmount", "roundingDust"],
};
function event(r: Row) {
  if (!hash(r.dealId) || !address(r.auction) || !uint(r.block) || !hash(r.blockHash)
    || !hash(r.transactionHash) || !integer(r.timestamp) || !integer(r.logIndex)
    || typeof r.kind !== "string" || !Object.hasOwn(eventAmounts, r.kind) || !amounts(r, eventAmounts[r.kind]!)) return false;
  if (r.kind === "auction-open") return addresses(r, ["coin", "creator"]) && texts(r, ["name", "symbol"]);
  if (["auction-bid", "auction-exit", "auction-claim"].includes(r.kind)) return address(r.owner);
  if (r.kind === "auction-checkpoint") return integer(r.cumulativeMps);
  if (r.kind === "auction-sweep") return r.asset === "quote" || r.asset === "coin";
  return typeof r.successful === "boolean";
}
function candle(v: unknown) {
  if (!object(v) || !integer(v.time) || !amounts(v, ["openWad", "highWad", "lowWad", "closeWad", "volumeUsdcUnits"])) return false;
  const open = BigInt(v.openWad as string), high = BigInt(v.highWad as string);
  const low = BigInt(v.lowWad as string), close = BigInt(v.closeWad as string);
  return low <= open && low <= close && high >= open && high >= close;
}
export function validItem(resource: string, v: unknown): boolean {
  if (!object(v)) return false;
  switch (resource) {
    case "auctions": return market(v) && v.mode === "auction" && address(v.auction) && texts(v, ["status"])
      && integer(v.startBlock) && integer(v.endBlock) && v.startBlock < v.endBlock
      && (v.checkpointBlock === null || integer(v.checkpointBlock))
      && amounts(v, ["floorPriceQ96", "clearingPriceQ96", "targetUnits"])
      && ["proceedsUnits", "soldUnits", "returnedUnits"].every(k => v[k] === null || uint(v[k]));
    case "bids": return hash(v.dealId) && addresses(v, ["auction", "owner", "quoteAsset"])
      && texts(v, ["status"]) && amounts(v, ["bidId", "maxPriceQ96", "amountUnits", "tokensFilled", "refundedUnits"]);
    case "auction-activity": return event(v);
    case "auction-prices": return integer(v.blockNumber) && integer(v.time) && uint(v.clearingPriceQ96) && integer(v.cumulativeMps);
    case "markets": return market(v) && v.mode === "reserve" && uint(v.spotPriceWad)
      && (v.latestTradeAt === null || integer(v.latestTradeAt));
    case "trades": return ["buy", "sell"].includes(String(v.side)) && address(v.trader)
      && amounts(v, ["coinAmount", "quoteAmount", "feeAmount", "blockNumber"])
      && integer(v.timestamp) && integer(v.logIndex) && hash(v.transactionHash);
    case "candles": return hash(v.dealId) && ["USDC", "Oxy-USDC"].includes(String(v.quoteAsset))
      && ["1m", "15m", "1h", "1d"].includes(String(v.interval)) && uint(v.spotPriceWad)
      && integer(v.launchedAt) && Array.isArray(v.points) && v.points.length <= 5000 && v.points.every(candle);
    case "volume": return hash(v.dealId) && integer(v.asOf)
      && amounts(v, ["volume24hQuoteUnits", "previous24hQuoteUnits", "volume1hQuoteUnits"])
      && BigInt(v.volume1hQuoteUnits as string) <= BigInt(v.volume24hQuoteUnits as string)
      && (v.lastTradeAt === null || integer(v.lastTradeAt));
    default: return false;
  }
}
export function validEnvelope(v: unknown, resource: string): v is Row & { items: unknown[] } {
  if (!object(v) || v.apiVersion !== "1" || v.source !== "indexed" || v.resource !== resource
    || !integer(v.chainId) || v.chainId === 0 || !texts(v, ["releaseId"])
    || !hash(v.candidateHash) || !hash(v.bindingFingerprint) || !integer(v.generation)
    || !uint(v.indexedBlock) || !hash(v.indexedBlockHash) || !integer(v.checkedAt)
    || !object(v.quoteToken) || !address(v.quoteToken.address) || v.quoteToken.decimals !== 6
    || !["USDC", "Oxy-USDC"].includes(String(v.quoteToken.symbol)) || v.error !== undefined
    || !Array.isArray(v.items)) return false;
  if (v.indexedTimestamp !== undefined && !integer(v.indexedTimestamp)) return false;
  if (v.freshness !== "fresh" && !(v.freshness === "stale" && v.readState === "complete-prefix"
    && uint(v.finalizedBlock) && uint(v.lagBlocks) && BigInt(v.lagBlocks) > 0n
    && BigInt(v.finalizedBlock) - BigInt(v.indexedBlock) === BigInt(v.lagBlocks))) return false;
  if (v.snapshotBlock !== undefined && (!uint(v.snapshotBlock) || BigInt(v.snapshotBlock) > BigInt(v.indexedBlock))) return false;
  if (v.snapshotBlockHash !== undefined && !hash(v.snapshotBlockHash)) return false;
  if (v.hasMore !== undefined || v.nextCursor !== undefined) {
    if (typeof v.hasMore !== "boolean" || (v.hasMore ? typeof v.nextCursor !== "string"
      || v.nextCursor.length < 1 || v.nextCursor.length > 1600 : v.nextCursor !== null)) return false;
  }
  const max = resource === "auction-prices" ? 1000 : ["candles", "volume"].includes(resource) ? 1 : 50;
  return v.items.length <= max && v.items.every(item => validItem(resource, item));
}
