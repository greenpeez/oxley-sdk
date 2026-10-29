import {object} from "./data-validation.js";
import {DataApiError} from "./data-errors.js";
export function retryDelay(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}
export async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new DataApiError("INVALID_RESPONSE", response.status);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new DataApiError("RESPONSE_TOO_LARGE", response.status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new DataApiError("INVALID_RESPONSE", response.status); }
}
export function dataErrorCode(payload:unknown):string {
  if(!object(payload))return "HTTP_ERROR";
  if(object(payload.error)&&payload.error.code==="challenge")return "PLATFORM_CHALLENGE";
  return typeof payload.error==="string"&&/^[A-Z][A-Z0-9_]{0,63}$/.test(payload.error)?payload.error:"HTTP_ERROR";
}
