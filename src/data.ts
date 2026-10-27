import {integer} from "./data-validation.js";
import {dataReader} from "./data-request.js";
import {dataRoot} from "./data-options.js";
export {DataApiError} from "./data-errors.js";
import type { Auction, AuctionActivity, AuctionActivityQuery, AuctionPrice, AuctionPriceQuery, AuctionQuery,
  BidQuery, CandleQuery, CandleSeries, DataRequestOptions, IndexedBid, IndexedData, IndexedMarket,
  IndexedTrade, MarketQuery, MarketVolume, TradeQuery, VolumeQuery } from "./data-types.js";
export type * from "./data-types.js";

export interface DataClientOptions {
  /** Absolute API root, including /api/data/v1. HTTPS except on localhost. */
  baseUrl: string;
  chainId: number;
  /** Optional asset pin; use the deployment's canonical USDC or testnet Oxy-USDC address. */
  quoteAsset?: `0x${string}`;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
/** Recheck this when rendering retained data; fetching once does not keep it fresh. */
export function isCurrentData(value: Pick<IndexedData<unknown>, "checkedAt" | "freshness"> &
  Partial<Pick<IndexedData<unknown>, "indexedTimestamp" | "indexedBlock" | "finalizedBlock" | "lagBlocks" | "latestBlock" | "latestTimestamp" | "indexedBlockHash">>, now = Date.now()): boolean {
  return value.freshness === "fresh" && currentTime(value.checkedAt,now) && currentTime(value.indexedTimestamp,now)
    && value.lagBlocks === "0" && typeof value.indexedBlock === "string" && /^\d+$/.test(value.indexedBlock)
    && value.finalizedBlock === value.indexedBlock && currentHead(value,now) && canonicalHash(value.indexedBlockHash);
}
function canonicalHash(value:unknown) {return typeof value==="string"&&/^0x[0-9a-f]{64}$/iu.test(value);}
function currentHead(value:{latestBlock?:string|null;latestTimestamp?:number|null;indexedBlock?:string},now:number) {
  return typeof value.latestBlock==="string"&&/^\d+$/.test(value.latestBlock)
    &&BigInt(value.latestBlock)>=BigInt(value.indexedBlock!)&&currentTime(value.latestTimestamp,now);
}
function currentTime(value:unknown,now:number) {
  return integer(value) && Number(value)*1000 <= now+30_000 && now-Number(value)*1000<=180_000;
}
export function createOxleyDataClient(options:DataClientOptions) {
  const root=dataRoot(options);
  const get=dataReader(root,options);
  return {
    auctions: (query: AuctionQuery, request?: DataRequestOptions) => get<Auction>("auctions", query, request),
    bids: (query: BidQuery, request?: DataRequestOptions) => get<IndexedBid>("bids", query, request),
    auctionActivity: (query: AuctionActivityQuery, request?: DataRequestOptions) => get<AuctionActivity>("auction-activity", query, request),
    auctionPrices: (query: AuctionPriceQuery, request?: DataRequestOptions) => get<AuctionPrice>("auction-prices", query, request),
    markets: (query: MarketQuery = {}, request?: DataRequestOptions) => get<IndexedMarket>("markets", query, request),
    trades: (query: TradeQuery, request?: DataRequestOptions) => get<IndexedTrade>("trades", query, request),
    candles: (query: CandleQuery, request?: DataRequestOptions) => get<CandleSeries>("candles", query, request),
    volume: (query: VolumeQuery, request?: DataRequestOptions) => get<MarketVolume>("volume", query, request),
  };
}
export type OxleyDataClient = ReturnType<typeof createOxleyDataClient>;
