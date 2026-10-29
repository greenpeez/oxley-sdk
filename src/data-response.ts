import {object,validEnvelope} from "./data-validation.js";
import {DataApiError} from "./data-errors.js";
import type {DataClientOptions} from "./data.js";

type Row=Record<string,unknown>;
const same=(a:unknown,b:unknown)=>String(a).toLowerCase()===String(b).toLowerCase();
export function validateData(payload:unknown,resource:string,query:object,options:DataClientOptions) {
  if(!validEnvelope(payload,resource))throw new DataApiError("INVALID_RESPONSE",200);
  const quote=payload.quoteToken as {address:string},selected=query as Row;
  if(payload.chainId!==options.chainId||options.quoteAsset&&!same(quote.address,options.quoteAsset)
    ||!selectedIdentity(payload,selected)||!matchingItems(payload.items,resource,selected,quote.address))
    throw new DataApiError("DATA_IDENTITY_MISMATCH",200);
  if(["auctions","bids","markets","trades"].includes(resource)&&typeof payload.hasMore!=="boolean")
    throw new DataApiError("INVALID_RESPONSE",200);
  if(staleObservation(payload.checkedAt))
    throw new DataApiError("STALE_OBSERVATION",200);
  return payload;
}
function selectedIdentity(payload:Row,selected:Row) {
  return (selected.model===undefined||payload.model===selected.model)
    &&(selected.dealId===undefined||payload.dealId===undefined||same(payload.dealId,selected.dealId));
}
function matchingItems(items:unknown[],resource:string,selected:Row,quote:string) {
  return items.every(item=>!object(item)||itemIdentity(item,selected)&&itemQuery(item,resource,selected,quote));
}
function itemIdentity(item:Row,selected:Row) {
  return (selected.dealId===undefined||item.dealId===undefined||same(item.dealId,selected.dealId))
    &&(selected.owner===undefined||same(item.owner,selected.owner));
}
function itemQuery(item:Row,resource:string,selected:Row,quote:string) {
  return (selected.interval===undefined||item.interval===selected.interval)
    &&(selected.asOf===undefined||item.asOf===selected.asOf)
    &&(!["auctions","markets","bids"].includes(resource)||same(item.quoteAsset,quote));
}

function staleObservation(checkedAt:unknown) {return Date.now()-Number(checkedAt)*1000>180_000||Number(checkedAt)*1000>Date.now()+30_000;}
