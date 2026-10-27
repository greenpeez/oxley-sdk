import type {DataClientOptions} from "./data.js";
import {integer} from "./data-validation.js";
import {DataApiError} from "./data-errors.js";

export function dataRoot(options:DataClientOptions) {
  const root=new URL(options.baseUrl);
  if(root.username||root.password||root.search||root.hash||!secureRoot(root)||!validOptions(options))
    throw new DataApiError("INVALID_CLIENT_OPTIONS");
  root.pathname=root.pathname.replace(/\/$/,"")+"/";
  return root;
}
function secureRoot(root:URL) {
  return root.protocol==="https:"||root.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(root.hostname);
}
function validOptions(options:DataClientOptions) {
  const timeout=options.timeoutMs??15_000;
  return integer(options.chainId)&&options.chainId>0&&integer(timeout)&&timeout>=1&&timeout<=120_000
    &&(options.quoteAsset===undefined||/^0x[\da-f]{40}$/i.test(options.quoteAsset));
}
