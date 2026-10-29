import {DataApiError} from "./data-errors.js";
import {integer} from "./data-validation.js";
import {dataErrorCode,readJson,retryDelay} from "./data-http.js";
import {validateData} from "./data-response.js";
import {dataAbortScope} from "./data-abort.js";
import type {DataClientOptions} from "./data.js";
import type {DataRequestOptions,IndexedData} from "./data-types.js";

function queryUrl(root:URL,resource:string,query:object) {
  const url=new URL(resource,root);
  for(const [key,value] of Object.entries(query)) {
    if(value===undefined)continue;
    if(!(typeof value==="string"||typeof value==="number"&&integer(value)))throw new DataApiError("INVALID_QUERY");
    url.searchParams.set(key,String(value));
  }
  return url;
}
async function responseData(response:Response,signal:AbortSignal) {
  let payload:unknown;
  try {payload=await readJson(response);}catch(error){if(response.ok)throw error;}
  if(signal.aborted)throw signal.reason;
  if(!response.ok) {
    const code=response.headers.get("x-vercel-mitigated")==="challenge"?"PLATFORM_CHALLENGE":dataErrorCode(payload);
    throw new DataApiError(code,response.status,retryDelay(response));
  }
  return payload;
}
export function dataReader(root:URL,options:DataClientOptions) {
  const transport=options.fetch??globalThis.fetch;
  return async function get<T>(resource:string,query:object,request:DataRequestOptions={}):Promise<IndexedData<T>> {
    const url=queryUrl(root,resource,query),scope=dataAbortScope(request.signal,options.timeoutMs??15_000);
    const signal=scope.signal;
    try {
      if(signal.aborted)throw signal.reason;
      const response=await transport(url,{method:"GET",headers:{accept:"application/json"},credentials:"omit",redirect:"error",cache:"no-store",signal});
      const payload=await responseData(response,signal);
      return validateData(payload,resource,query,options) as unknown as IndexedData<T>;
    } catch(error) {
      if(request.signal?.aborted)throw new DataApiError("ABORTED");
      if(scope.timedOut())throw new DataApiError("TIMEOUT");
      if(error instanceof DataApiError)throw error;
      throw new DataApiError("NETWORK_ERROR");
    } finally {scope.dispose();}
  };
}
