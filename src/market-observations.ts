/** Display observations, qualified by generation and canonical chain provenance. Never transaction authority. */
export interface MarketObservationIdentity {
  chainId: number; generation: string; dealId: string; coin: string; curve: string; quoteAsset: string;
  blockNumber: string; blockHash: string; blockTimestamp: number; checkedAt: number;
}
export interface MarketCapitalization extends MarketObservationIdentity {
  definition: "outside-curve-v1"; spotPriceWad: string; totalSupplyUnits: string; curveBalanceUnits: string;
  outsideCurveSupplyUnits: string; marketCapQuoteUnits: string;
}
export interface MarketProtocolObservation extends MarketObservationIdentity {
  feeRouter: string;
  listing: {address: string | null; configured: boolean; activatedAt: number; expiresAt: number; purchased: boolean; commitmentBps: number} | null;
  creatorRewardLock: {durationDays: 0 | 30 | 60; unlockAt: number; activated: boolean} | null;
  asOf?: {blockNumber: string; blockHash: string; timestamp: number};
}
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const address = (v: unknown) => typeof v === "string" && /^0x[\da-f]{40}$/iu.test(v);
const hash = (v: unknown) => typeof v === "string" && /^0x[\da-f]{64}$/iu.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const uint = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,77})$/u.test(v) && BigInt(v) < (1n << 256n);
function identity(v: Row) {
  return [Number.isSafeInteger(v.chainId), Number(v.chainId) > 0,
    typeof v.generation === "string" && /^[a-z0-9.-]{3,64}$/u.test(v.generation), hash(v.dealId), hash(v.blockHash), uint(v.blockNumber),
    ["coin","curve","quoteAsset"].every(key => address(v[key])), count(v.blockTimestamp), count(v.checkedAt)].every(Boolean);
}
export function validMarketCapitalization(v: unknown): v is MarketCapitalization {
  if (!object(v) || !identity(v) || v.definition !== "outside-curve-v1") return false;
  if (![v.spotPriceWad,v.totalSupplyUnits,v.curveBalanceUnits,v.outsideCurveSupplyUnits].every(uint)) return false;
  const supply = BigInt(v.totalSupplyUnits as string), balance = BigInt(v.curveBalanceUnits as string);
  return balance <= supply && String(supply - balance) === v.outsideCurveSupplyUnits
    && String(BigInt(v.spotPriceWad as string) * (supply - balance) / 10n ** 36n) === v.marketCapQuoteUnits;
}
function listing(v: unknown) {
  if (v === null) return true;
  if (!object(v) || typeof v.configured !== "boolean" || typeof v.purchased !== "boolean") return false;
  if (!listingTime(v)) return false;
  if (v.address !== null && !address(v.address)) return false;
  return v.configured ? address(v.address) && [5000,10000].includes(Number(v.commitmentBps)) : v.commitmentBps === 0;
}
function listingTime(v:Row) {
  return count(v.activatedAt)&&count(v.expiresAt)&&(v.activatedAt===0||Number(v.expiresAt)-Number(v.activatedAt)===180*86400);
}
function lock(v: unknown) {
  return v === null || object(v) && [0,30,60].includes(Number(v.durationDays)) && typeof v.durationDays === "number"
    && count(v.unlockAt) && typeof v.activated === "boolean";
}
export function validMarketProtocolObservation(v: unknown): v is MarketProtocolObservation {
  if (!object(v) || !identity(v) || !address(v.feeRouter) || !listing(v.listing) || !lock(v.creatorRewardLock)) return false;
  return validAsOf(v);
}
function validAsOf(v: Row) {
  if (v.asOf === undefined) return true;
  const at = v.asOf;
  return object(at) && uint(at.blockNumber) && hash(at.blockHash) && count(at.timestamp)
    && BigInt(at.blockNumber) >= BigInt(v.blockNumber as string) && Number(at.timestamp) >= Number(v.blockTimestamp);
}
function matches(observation: MarketObservationIdentity, parent: Row) {
  return ["dealId","coin","quoteAsset"].every(key => String(observation[key as keyof MarketObservationIdentity]).toLowerCase() === String(parent[key]).toLowerCase());
}
/** Historical responses may omit the additions. Supplied malformed or cross-market observations fail closed. */
export function validMarketObservationFields(row: Row) {
  const cap = row.capitalization, protocol = row.protocolObservation;
  const capValid = cap == null || validMarketCapitalization(cap) && matches(cap,row);
  const protocolValid = protocol == null || validMarketProtocolObservation(protocol) && matches(protocol,row);
  return capValid && protocolValid;
}
