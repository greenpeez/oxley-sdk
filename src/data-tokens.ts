import {DataApiError} from "./data-errors.js";
import type {DataRequestOptions,IndexedData,TokenInfo,TokenQuery} from "./data-types.js";

/** The API answers at most 50 markets per request; a few requests at a time keep a long list from bursting. */
export const TOKEN_BATCH=50,TOKEN_PARALLEL=4;
type Get=<T>(resource:string,query:object,request?:DataRequestOptions)=>Promise<IndexedData<T>>;
const dealId=/^0x[0-9a-f]{64}$/;

function requestedIds(query:TokenQuery) {
  const ids=Array.isArray(query?.ids)?[...new Set(query.ids.map(id=>typeof id==="string"?id.toLowerCase():""))]:[];
  if(!ids.length||!ids.every(id=>dealId.test(id)))throw new DataApiError("INVALID_QUERY");
  return ids;
}
const older=(a:IndexedData<TokenInfo>,b:IndexedData<TokenInfo>)=>
  a.checkedAt!==b.checkedAt?a.checkedAt<b.checkedAt:BigInt(a.indexedBlock)<=BigInt(b.indexedBlock);
/**
 * Reads any number of markets in batches of 50 and returns one answer. Its observation is the oldest batch's, so
 * `isCurrentData` never rates the merge fresher than its least fresh part. Markets the API does not list (unknown, or retired
 * auctions) are absent from `items`; compare with the IDs you asked for. A batch that fails fails the whole read.
 */
export async function readTokens(get:Get,query:TokenQuery,request?:DataRequestOptions):Promise<IndexedData<TokenInfo>> {
  const ids=requestedIds(query),batches:string[][]=[],pages:IndexedData<TokenInfo>[]=[];
  for(let start=0;start<ids.length;start+=TOKEN_BATCH)batches.push(ids.slice(start,start+TOKEN_BATCH));
  for(let start=0;start<batches.length;start+=TOKEN_PARALLEL) {
    const wave=batches.slice(start,start+TOKEN_PARALLEL);
    pages.push(...await Promise.all(wave.map(batch=>get<TokenInfo>("tokens",{ids:batch.join(",")},request))));
  }
  const base=pages.reduce((oldest,page)=>older(page,oldest)?page:oldest);
  return pages.length===1?base:{...base,items:pages.flatMap(page=>page.items)};
}
