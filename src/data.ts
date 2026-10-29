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
type Observation = Pick<IndexedData<unknown>, "checkedAt" | "freshness"> & Partial<Pick<IndexedData<unknown>, "indexedTimestamp" | "indexedBlock"
  | "finalizedBlock" | "lagBlocks" | "latestBlock" | "latestTimestamp" | "indexedBlockHash" | "confirmation" | "finalizedBlockHash" | "latestBlockHash">>;
/**
 * Recheck this when rendering retained data; fetching once does not keep it fresh. A finalized-prefix response (no `confirmation`)
 * is current only when the index sits exactly on the finalized block (`lagBlocks` "0"). A `canonical-tip` response is current when
 * it is `fresh`, `finalizedBlock <= indexedBlock` and `lagBlocks` is absent. Either way every timestamp must be within 180 seconds
 * (30 in the future), the head evidence must be consistent, and every `sources[]` entry must be current under its own rule.
 */
export function isCurrentData(value: Observation & { sources?: readonly Observation[] }, now = Date.now()): boolean {
  return currentObservation(value, now) && (value.sources === undefined
    || Array.isArray(value.sources) && value.sources.every(source => source !== null && typeof source === "object" && currentObservation(source, now)));
}
const decimal = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
function currentObservation(value: Observation, now: number): boolean {
  const mode = value.confirmation;
  return value.freshness === "fresh" && (mode === undefined || mode === "finalized-prefix" || mode === "canonical-tip")
    && recentObservation(value, now) && currentHead(value, now) && hashesValid(value)
    && (mode === "canonical-tip" ? tipFinality(value) : prefixFinality(value));
}
const recentObservation = (value: Observation, now: number) => currentTime(value.checkedAt, now) && currentTime(value.indexedTimestamp, now) && decimal(value.indexedBlock);
const hashesValid = (value: Observation) => canonicalHash(value.indexedBlockHash)
  && [value.finalizedBlockHash, value.latestBlockHash].every(hash => hash === undefined || canonicalHash(hash));
const prefixFinality = (value: Observation) => value.lagBlocks === "0" && value.finalizedBlock === value.indexedBlock;
const tipFinality = (value: Observation) => value.lagBlocks === undefined && decimal(value.finalizedBlock) && BigInt(value.finalizedBlock) <= BigInt(value.indexedBlock!);
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
