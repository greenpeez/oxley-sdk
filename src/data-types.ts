/** Integer base units and fixed-point values are never converted to JS numbers. */
import type {MarketCapitalization, MarketProtocolObservation} from "./market-observations.js";
export type DecimalString = string;
export type DataAddress = `0x${string}`;
export type DealId = `0x${string}`;
export type AuctionModel = "cca" | "bonded-v2";
export type CandleInterval = "1m" | "15m" | "1h" | "1d";
export interface DataRequestOptions { signal?: AbortSignal }
export interface DataPageQuery { cursor?: string; limit?: number }
export interface AuctionQuery extends DataPageQuery { model: AuctionModel; dealId?: DealId; q?: string }
export interface BidQuery extends DataPageQuery { model: AuctionModel; owner: DataAddress; dealId: DealId }
export interface AuctionActivityQuery { model: AuctionModel; dealId: DealId }
export interface AuctionPriceQuery extends AuctionActivityQuery { fromBlock: number; toBlock: number }
export interface MarketQuery extends DataPageQuery { dealId?: DealId; q?: string }
export interface TradeQuery extends DataPageQuery { dealId: DealId; from: number; to: number; wallet?: DataAddress }
export interface CandleQuery { dealId: DealId; interval: CandleInterval; from: number; to: number }
export interface VolumeQuery { dealId: DealId; asOf: number }

export interface IndexedData<T> {
  apiVersion: "1";
  source: "indexed";
  resource: string;
  model?: AuctionModel;
  chainId: number;
  releaseId: string;
  sourceReleaseId?: string | null;
  /** Market deployment identity, distinct from the feed's releaseId; absent when unverified. */
  deploymentReleaseId?: string;
  feedIdentity?:{releaseId:string;candidateHash:string;bindingFingerprint:string;reorgGeneration:number};
  deploymentIdentity?:MarketDeploymentIdentity|null;
  latestBlock?:DecimalString|null;
  latestTimestamp?:number|null;
  finalizedTimestamp?:number;
  headLagBlocks?:DecimalString|null;
  finalityLagBlocks?:DecimalString|null;
  delayReason?:string|null;
  candidateHash: string;
  bindingFingerprint: string;
  generation: number;
  indexedBlock: DecimalString;
  indexedBlockHash: string;
  indexedTimestamp?: number;
  /** Unix seconds of the indexer's observation, not the client's fetch time. */
  checkedAt: number;
  freshness: "fresh" | "stale";
  readState?: "complete-prefix";
  finalizedBlock?: DecimalString;
  lagBlocks?: DecimalString;
  quoteToken: { address: DataAddress; symbol: "USDC" | "Oxy-USDC"; decimals: 6 };
  snapshotBlock?: DecimalString;
  snapshotBlockHash?: string;
  hasMore?: boolean;
  nextCursor?: string | null;
  from?: number;
  to?: number;
  dealId?: DealId;
  kind?: "cca-checkpoints";
  items: T[];
}
export interface Auction {
  deploymentIdentity?:MarketDeploymentIdentity|null;
  capitalization?: MarketCapitalization | null; protocolObservation?: MarketProtocolObservation | null;
  dealId: DealId; mode: "auction"; auction: DataAddress; coin: DataAddress; creator: DataAddress;
  name: string; symbol: string; launchedAt: number; startBlock: number; endBlock: number;
  floorPriceQ96: DecimalString; clearingPriceQ96: DecimalString; checkpointBlock: number | null;
  targetUnits: DecimalString; proceedsUnits: DecimalString | null; soldUnits: DecimalString | null; returnedUnits: DecimalString | null;
  status: string; quoteAsset: DataAddress; quoteSymbol: "USDC" | "Oxy-USDC";
}
export interface IndexedBid {
  dealId: DealId; auction: DataAddress; bidId: DecimalString; owner: DataAddress;
  maxPriceQ96: DecimalString; amountUnits: DecimalString; status: string;
  tokensFilled: DecimalString; refundedUnits: DecimalString; quoteAsset: DataAddress;
}
interface AuctionEventBase {
  dealId: DealId; auction: DataAddress; block: DecimalString; blockHash: string;
  timestamp: number; transactionHash: string; logIndex: number;
}
export type AuctionActivity = AuctionEventBase & (
  | { kind: "auction-open"; coin: DataAddress; creator: DataAddress; name: string; symbol: string;
      startBlock: DecimalString; endBlock: DecimalString; floorQ96: DecimalString; tickQ96: DecimalString; targetUnits: DecimalString }
  | { kind: "auction-bid"; bidId: DecimalString; owner: DataAddress; priceQ96: DecimalString; amountUnits: DecimalString }
  | { kind: "auction-checkpoint"; checkpointBlock: DecimalString; clearingQ96: DecimalString; cumulativeMps: number }
  | { kind: "auction-exit"; bidId: DecimalString; owner: DataAddress; tokensFilled: DecimalString; refundedUnits: DecimalString }
  | { kind: "auction-claim"; bidId: DecimalString; owner: DataAddress; tokensFilled: DecimalString }
  | { kind: "auction-sweep"; asset: "quote" | "coin"; amount: DecimalString }
  | { kind: "auction-settle"; successful: boolean; proceeds: DecimalString; soldSupply: DecimalString;
      returnedSupply: DecimalString; curveSeed: DecimalString; platformAmount: DecimalString; roundingDust: DecimalString }
);
export interface AuctionPrice { blockNumber: number; time: number; clearingPriceQ96: DecimalString; cumulativeMps: number }
export interface IndexedMarket {
  deploymentIdentity?:MarketDeploymentIdentity|null;
  capitalization?: MarketCapitalization | null; protocolObservation?: MarketProtocolObservation | null;
  dealId: DealId; mode: "reserve"; coin: DataAddress; creator: DataAddress; name: string; symbol: string;
  launchedAt: number; spotPriceWad: DecimalString; latestTradeAt: number | null;
  quoteAsset: DataAddress; quoteSymbol: "USDC" | "Oxy-USDC";
}
export interface IndexedTrade {
  side: "buy" | "sell"; trader: DataAddress; coinAmount: DecimalString; quoteAmount: DecimalString;
  feeAmount: DecimalString; timestamp: number; transactionHash: string; blockNumber: DecimalString; logIndex: number;
}
export interface Candle {
  time: number; openWad: DecimalString; highWad: DecimalString; lowWad: DecimalString;
  closeWad: DecimalString; volumeUsdcUnits: DecimalString;
}
export interface CandleSeries {
  dealId: DealId; quoteAsset: "USDC" | "Oxy-USDC"; interval: CandleInterval;
  spotPriceWad: DecimalString; launchedAt: number; points: Candle[];
}
export interface MarketVolume {
  dealId: DealId; asOf: number; volume24hQuoteUnits: DecimalString;
  previous24hQuoteUnits: DecimalString; volume1hQuoteUnits: DecimalString; lastTradeAt: number | null;
}

export interface MarketDeploymentIdentity {
  chainId:number;source:"canonical-launch"|"verified-binding";releaseId:string|null;
  observedBlock:DecimalString;observedBlockHash:string;
  controller:{address:DataAddress;runtimeCodeHash:string};adapter?:{address:DataAddress;runtimeCodeHash:string};
  curve:{address:DataAddress;runtimeCodeHash:string};quote:{address:DataAddress;runtimeCodeHash:string};
}
