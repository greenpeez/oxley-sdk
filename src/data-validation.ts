import {validMarketObservationFields} from "./market-observations.js";
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
const market = (r: Row) => hash(r.dealId) && addresses(r, ["coin", "creator"]) && validMarketObservationFields(r)
  && texts(r, ["name", "symbol"]) && integer(r.launchedAt) && quote(r);
const eventAmounts: Record<string, string[]> = {
  "auction-open": ["startBlock", "endBlock", "floorQ96", "tickQ96", "targetUnits"],
  "auction-bid": ["bidId", "priceQ96", "amountUnits"],
  "auction-checkpoint": ["checkpointBlock", "clearingQ96"],
  "auction-exit": ["bidId", "tokensFilled", "refundedUnits"],
  "auction-claim": ["bidId", "tokensFilled"], "auction-sweep": ["amount"],
  "auction-settle": ["proceeds", "soldSupply", "returnedSupply", "curveSeed", "platformAmount", "roundingDust"],
};
const eventChecks:Record<string,(r:Row)=>boolean>={
  "auction-open":r=>addresses(r,["coin","creator"])&&texts(r,["name","symbol"]),
  "auction-bid":r=>address(r.owner),"auction-exit":r=>address(r.owner),"auction-claim":r=>address(r.owner),
  "auction-checkpoint":r=>integer(r.cumulativeMps),"auction-sweep":r=>r.asset==="quote"||r.asset==="coin",
  "auction-settle":r=>typeof r.successful==="boolean",
};
function event(r:Row) {
  if(typeof r.kind!=="string"||!Object.hasOwn(eventAmounts,r.kind))return false;
  const identity=[hash(r.dealId),address(r.auction),uint(r.block),hash(r.blockHash),hash(r.transactionHash),
    integer(r.timestamp),integer(r.logIndex)].every(Boolean);
  return identity&&amounts(r,eventAmounts[r.kind]!)&&eventChecks[r.kind]!(r);
}
function candle(v: unknown) {
  if (!object(v) || !integer(v.time) || !amounts(v, ["openWad", "highWad", "lowWad", "closeWad", "volumeUsdcUnits"])) return false;
  const open = BigInt(v.openWad as string), high = BigInt(v.highWad as string);
  const low = BigInt(v.lowWad as string), close = BigInt(v.closeWad as string);
  return low <= open && low <= close && high >= open && high >= close;
}
function auction(r:Row) {
  return market(r)&&r.mode==="auction"&&address(r.auction)&&texts(r,["status"])&&schedule(r)
    &&amounts(r,["floorPriceQ96","clearingPriceQ96","targetUnits"])
    &&["proceedsUnits","soldUnits","returnedUnits"].every(k=>r[k]===null||uint(r[k]));
}
function schedule(r:Row) {
  return integer(r.startBlock)&&integer(r.endBlock)&&r.startBlock<r.endBlock
    &&(r.checkpointBlock===null||integer(r.checkpointBlock));
}
function candleSeries(r:Row) {
  return hash(r.dealId)&&["USDC","Oxy-USDC"].includes(String(r.quoteAsset))
    &&["1m","15m","1h","1d"].includes(String(r.interval))&&uint(r.spotPriceWad)
    &&integer(r.launchedAt)&&Array.isArray(r.points)&&r.points.length<=5000&&r.points.every(candle);
}
const itemChecks:Record<string,(r:Row)=>boolean>={
  auctions:auction,
  bids:r=>hash(r.dealId)&&addresses(r,["auction","owner","quoteAsset"])&&texts(r,["status"])
    &&amounts(r,["bidId","maxPriceQ96","amountUnits","tokensFilled","refundedUnits"]),
  "auction-activity":event,
  "auction-prices":r=>integer(r.blockNumber)&&integer(r.time)&&uint(r.clearingPriceQ96)&&integer(r.cumulativeMps),
  markets:r=>market(r)&&r.mode==="reserve"&&uint(r.spotPriceWad)&&(r.latestTradeAt===null||integer(r.latestTradeAt)),
  trades:r=>["buy","sell"].includes(String(r.side))&&address(r.trader)&&amounts(r,["coinAmount","quoteAmount","feeAmount","blockNumber"])
    &&integer(r.timestamp)&&integer(r.logIndex)&&hash(r.transactionHash),
  candles:candleSeries,
  volume:r=>hash(r.dealId)&&integer(r.asOf)&&amounts(r,["volume24hQuoteUnits","previous24hQuoteUnits","volume1hQuoteUnits"])
    &&BigInt(r.volume1hQuoteUnits as string)<=BigInt(r.volume24hQuoteUnits as string)&&(r.lastTradeAt===null||integer(r.lastTradeAt)),
};
export function validItem(resource:string,v:unknown):boolean {
  return object(v)&&Object.hasOwn(itemChecks,resource)&&itemChecks[resource]!(v);
}
function quoteToken(v:unknown) {
  return object(v)&&address(v.address)&&v.decimals===6&&["USDC","Oxy-USDC"].includes(String(v.symbol));
}
function envelopeIdentity(v:Row,resource:string) {
  return [v.apiVersion==="1",v.source==="indexed",v.resource===resource,integer(v.chainId),v.chainId!==0,
    texts(v,["releaseId"]),hash(v.candidateHash),hash(v.bindingFingerprint),integer(v.generation),uint(v.indexedBlock),
    hash(v.indexedBlockHash),integer(v.checkedAt),quoteToken(v.quoteToken),v.error===undefined,Array.isArray(v.items)].every(Boolean);
}
function freshness(v:Row) {
  if(v.freshness==="fresh")return true;
  return v.freshness==="stale"&&v.readState==="complete-prefix"&&uint(v.finalizedBlock)&&uint(v.lagBlocks)
    &&BigInt(v.lagBlocks)>=0n&&BigInt(v.finalizedBlock)-BigInt(v.indexedBlock as string)===BigInt(v.lagBlocks);
}
function snapshot(v:Row) {
  if(v.indexedTimestamp!==undefined&&!integer(v.indexedTimestamp))return false;
  if(v.snapshotBlock!==undefined&&(!uint(v.snapshotBlock)||BigInt(v.snapshotBlock)>BigInt(v.indexedBlock as string)))return false;
  return v.snapshotBlockHash===undefined||hash(v.snapshotBlockHash);
}
function pagination(v:Row) {
  if(v.hasMore===undefined&&v.nextCursor===undefined)return true;
  if(typeof v.hasMore!=="boolean")return false;
  return v.hasMore?typeof v.nextCursor==="string"&&v.nextCursor.length>=1&&v.nextCursor.length<=1600:v.nextCursor===null;
}
export function validEnvelope(v:unknown,resource:string):v is Row&{items:unknown[]} {
  if(!object(v)||!envelopeIdentity(v,resource)||!freshness(v)||!snapshot(v)||!pagination(v))return false;
  const items=v.items as unknown[],limits:Record<string,number>={"auction-prices":1000,candles:1,volume:1};
  const max=Object.hasOwn(limits,resource)?limits[resource]!:50;
  return items.length<=max&&items.every(item=>validItem(resource,item));
}
