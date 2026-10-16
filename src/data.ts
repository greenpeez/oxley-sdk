import { integer, object, validEnvelope } from "./data-validation.js";
import type { Auction, AuctionActivity, AuctionActivityQuery, AuctionPrice, AuctionPriceQuery, AuctionQuery,
  BidQuery, CandleQuery, CandleSeries, DataRequestOptions, IndexedBid, IndexedData, IndexedMarket,
  IndexedTrade, MarketQuery, MarketVolume, TradeQuery, VolumeQuery } from "./data-types.js";
export type * from "./data-types.js";

export class DataApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfterMs?: number) {
    super(code); this.name = "DataApiError";
  }
}
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
export function isCurrentData(value: Pick<IndexedData<unknown>, "checkedAt" | "freshness">, now = Date.now()): boolean {
  return value.freshness === "fresh" && integer(value.checkedAt) && value.checkedAt * 1000 <= now + 30_000
    && now - value.checkedAt * 1000 <= 180_000;
}
function retryDelay(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return;
  const seconds = /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}
async function readJson(response: Response): Promise<unknown> {
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
export function createOxleyDataClient(options: DataClientOptions) {
  const root = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (root.username || root.password || root.search || root.hash
    || !(root.protocol === "https:" || root.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(root.hostname))
    || !integer(options.chainId) || options.chainId === 0 || !integer(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || options.quoteAsset !== undefined && !/^0x[\da-f]{40}$/i.test(options.quoteAsset)) throw new DataApiError("INVALID_CLIENT_OPTIONS");
  root.pathname = root.pathname.replace(/\/$/, "") + "/";
  const transport = options.fetch ?? globalThis.fetch;
  async function get<T>(resource: string, query: object, request: DataRequestOptions = {}): Promise<IndexedData<T>> {
    const url = new URL(resource, root);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (!(typeof value === "string" || typeof value === "number" && integer(value))) throw new DataApiError("INVALID_QUERY");
      url.searchParams.set(key, String(value));
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    try {
      signal.throwIfAborted();
      const response = await transport(url, { method: "GET", headers: { accept: "application/json" },
        credentials: "omit", redirect: "error", cache: "no-store", signal });
      let payload: unknown;
      try { payload = await readJson(response); }
      catch (error) { if (response.ok) throw error; }
      signal.throwIfAborted();
      if (!response.ok) {
        const code = object(payload) && typeof payload.error === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(payload.error)
          ? payload.error : "HTTP_ERROR";
        throw new DataApiError(code, response.status, retryDelay(response));
      }
      if (!validEnvelope(payload, resource)) throw new DataApiError("INVALID_RESPONSE", response.status);
      if (payload.chainId !== options.chainId || options.quoteAsset
        && (payload.quoteToken as { address: string }).address.toLowerCase() !== options.quoteAsset.toLowerCase())
        throw new DataApiError("DATA_IDENTITY_MISMATCH", response.status);
      const selected = query as Record<string, unknown>;
      if (selected.model !== undefined && payload.model !== selected.model) throw new DataApiError("DATA_IDENTITY_MISMATCH", response.status);
      if (selected.dealId !== undefined && payload.dealId !== undefined
        && String(payload.dealId).toLowerCase() !== String(selected.dealId).toLowerCase()) throw new DataApiError("DATA_IDENTITY_MISMATCH", response.status);
      if (selected.dealId !== undefined && payload.items.some(item => object(item) && item.dealId !== undefined
        && String(item.dealId).toLowerCase() !== String(selected.dealId).toLowerCase())) throw new DataApiError("DATA_IDENTITY_MISMATCH", response.status);
      if (payload.items.some(item => object(item) && (
        selected.owner !== undefined && String(item.owner).toLowerCase() !== String(selected.owner).toLowerCase()
        || selected.interval !== undefined && item.interval !== selected.interval
        || selected.asOf !== undefined && item.asOf !== selected.asOf
        || ["auctions", "markets", "bids"].includes(resource)
          && String(item.quoteAsset).toLowerCase() !== String((payload.quoteToken as { address: string }).address).toLowerCase())))
        throw new DataApiError("DATA_IDENTITY_MISMATCH", response.status);
      if (["auctions", "bids", "markets", "trades"].includes(resource) && typeof payload.hasMore !== "boolean")
        throw new DataApiError("INVALID_RESPONSE", response.status);
      if (Date.now() - Number(payload.checkedAt) * 1000 > 180_000 || Number(payload.checkedAt) * 1000 > Date.now() + 30_000)
        throw new DataApiError("STALE_OBSERVATION", response.status);
      return payload as unknown as IndexedData<T>;
    } catch (error) {
      if (request.signal?.aborted) throw new DataApiError("ABORTED");
      if (deadline.aborted) throw new DataApiError("TIMEOUT");
      if (error instanceof DataApiError) throw error;
      throw new DataApiError("NETWORK_ERROR");
    }
  }
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
