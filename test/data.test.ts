import assert from "node:assert/strict";
import test from "node:test";
import { createOxleyDataClient, DataApiError, isCurrentData } from "../src/data.js";

const id = `0x${"1".repeat(64)}` as const, hash = `0x${"2".repeat(64)}`;
const address = `0x${"3".repeat(40)}` as const, owner = `0x${"4".repeat(40)}` as const;
const now = Math.floor(Date.now() / 1000), huge = "900719925474099312345678901234567890";
const auction = { dealId: id, mode: "auction", auction: address, coin: address, creator: owner,
  name: "Example", symbol: "TEST", launchedAt: now - 100, startBlock: 1, endBlock: 1000,
  floorPriceQ96: huge, clearingPriceQ96: huge, checkpointBlock: null, targetUnits: huge,
  proceedsUnits: null, soldUnits: null, returnedUnits: null, status: "bidding", quoteAsset: address, quoteSymbol: "Oxy-USDC" };
const bid = { dealId: id, auction: address, bidId: "0001", owner, maxPriceQ96: huge,
  amountUnits: huge, status: "active", tokensFilled: "0", refundedUnits: "0", quoteAsset: address };
const trade = { side: "sell", trader: owner, coinAmount: huge, quoteAmount: huge, feeAmount: "100",
  timestamp: now - 10, transactionHash: hash, blockNumber: "10", logIndex: 3 };
const point = { time: now - 60, openWad: huge, highWad: huge, lowWad: huge, closeWad: huge, volumeUsdcUnits: huge };
function wire(resource: string, items: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { apiVersion: "1", source: "indexed", resource, chainId: 99801, releaseId: "example",
    candidateHash: hash, bindingFingerprint: hash, generation: 0, indexedBlock: "100", indexedBlockHash: hash,
    checkedAt: now, indexedTimestamp:now,latestBlock:"102",latestTimestamp:now,finalizedBlock:"100",lagBlocks:"0", freshness: "fresh", quoteToken: { address, symbol: "Oxy-USDC", decimals: 6 },
    hasMore: false, nextCursor: null, items, ...extra };
}
function client(transport: typeof fetch) {
  return createOxleyDataClient({ baseUrl: "https://data.example/api/data/v1", chainId: 99801, quoteAsset: address, fetch: transport });
}
function error(code: string, status?: number) {
  return (e: unknown) => e instanceof DataApiError && e.code === code && (status === undefined || e.status === status);
}

test("data client reads all eight resources with exact financial strings and nullable auction outcomes", async () => {
  const items: Record<string, unknown[]> = {
    auctions: [auction], bids: [bid], markets: [{ ...auction, mode: "reserve", spotPriceWad: huge, latestTradeAt: null }],
    "auction-activity": [{ kind: "auction-bid", dealId: id, auction: address, block: "10", blockHash: hash,
      timestamp: now, transactionHash: hash, logIndex: 0, bidId: "1", owner, priceQ96: huge, amountUnits: huge }],
    "auction-prices": [{ blockNumber: 10, time: now, clearingPriceQ96: huge, cumulativeMps: 10 }],
    trades: [trade], candles: [{ dealId: id, quoteAsset: "Oxy-USDC", interval: "15m", spotPriceWad: huge,
      launchedAt: now - 100, points: [point] }],
    volume: [{ dealId: id, asOf: now, volume24hQuoteUnits: huge, previous24hQuoteUnits: "0", volume1hQuoteUnits: "5", lastTradeAt: null }],
  };
  const seen: string[] = [];
  const sdk = client(async (input, init) => {
    const url = new URL(String(input)), resource = url.pathname.split("/").at(-1)!;
    seen.push(resource); assert.equal(init?.method, "GET"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    return Response.json(wire(resource, items[resource], { model: url.searchParams.get("model") ?? undefined }));
  });
  assert.equal((await sdk.auctions({ model: "cca" })).items[0]?.proceedsUnits, null);
  assert.equal((await sdk.bids({ model: "bonded-v2", owner, dealId: id })).items[0]?.amountUnits, huge);
  await sdk.markets(); await sdk.auctionActivity({ model: "cca", dealId: id });
  await sdk.auctionPrices({ model: "bonded-v2", dealId: id, fromBlock: 1, toBlock: 100 });
  await sdk.trades({ dealId: id, from: now - 100, to: now });
  assert.equal((await sdk.candles({ dealId: id, from: now - 100, to: now, interval: "15m" })).items[0]?.points[0]?.volumeUsdcUnits, huge);
  assert.equal((await sdk.volume({ dealId: id, asOf: now })).items[0]?.volume24hQuoteUnits, huge);
  assert.equal(new Set(seen).size, 8);
});

test("data client preserves opaque cursors and empty pages with more results", async () => {
  const cursor = "opaque+/==&?";
  const sdk = client(async input => {
    assert.equal(new URL(String(input)).searchParams.get("cursor"), cursor);
    return Response.json(wire("bids", [], { model: "cca", hasMore: true, nextCursor: cursor }));
  });
  const page = await sdk.bids({ model: "cca", owner, dealId: id, cursor });
  assert.equal(page.hasMore, true); assert.deepEqual(page.items, []); assert.equal(page.nextCursor, cursor);
});

test("data client distinguishes delayed prefixes from expired observations", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: now * 1000 });
  const delayed = wire("markets", [], { freshness: "stale", readState: "complete-prefix", finalizedBlock: "110", lagBlocks: "10" });
  const page = await client(async () => Response.json(delayed)).markets();
  assert.equal(isCurrentData(page), false);
  assert.equal(isCurrentData({ checkedAt: now, freshness: "fresh" }), false);
  assert.equal(isCurrentData({...wire("markets"),freshness:"fresh"} as never),true);
  assert.equal(isCurrentData({ checkedAt: now, freshness: "fresh" }, (now + 181) * 1000), false);
  for (const change of [{ checkedAt: now - 181 }, { checkedAt: now + 31 }])
    await assert.rejects(client(async () => Response.json({ ...delayed, ...change })).markets(), error("STALE_OBSERVATION"));
  await assert.rejects(client(async () => Response.json({ ...delayed, lagBlocks: "2" })).markets(), error("INVALID_RESPONSE"));
});

test("data client rejects mismatched chain asset model market owner interval and numeric money", async () => {
  for (const patch of [{ chainId: 999 }, { quoteToken: { address: owner, symbol: "USDC", decimals: 6 } }, { model: "bonded-v2" }])
    await assert.rejects(client(async () => Response.json(wire("auctions", [auction], { model: "cca", ...patch })))
      .auctions({ model: "cca" }), error("DATA_IDENTITY_MISMATCH"));
  await assert.rejects(client(async () => Response.json(wire("auctions", [{ ...auction, dealId: hash }], { model: "cca" })))
    .auctions({ model: "cca", dealId: id }), error("DATA_IDENTITY_MISMATCH"));
  await assert.rejects(client(async () => Response.json(wire("bids", [bid], { model: "cca" })))
    .bids({ model: "cca", owner: address, dealId: id }), error("DATA_IDENTITY_MISMATCH"));
  await assert.rejects(client(async () => Response.json(wire("candles", [{ dealId: id, quoteAsset: "Oxy-USDC", interval: "1h",
    spotPriceWad: "1", launchedAt: now, points: [] }])))
    .candles({ dealId: id, interval: "15m", from: now - 100, to: now }), error("DATA_IDENTITY_MISMATCH"));
  await assert.rejects(client(async () => Response.json(wire("trades", [{ ...trade, quoteAmount: 1 }])))
    .trades({ dealId: id, from: now - 100, to: now }), error("INVALID_RESPONSE"));
});

test("data client surfaces HTTP errors retry-after and stale cursors without automatic retries", async () => {
  for (const [status, code] of [[429, "API_CAPACITY_EXCEEDED"], [503, "BACKEND_UNAVAILABLE"], [409, "CURSOR_STALE"], [404, "DEAL_NOT_FOUND"]] as const) {
    let calls = 0;
    const sdk = client(async () => { calls++; return Response.json({ error: code }, { status, headers: { "retry-after": "17" } }); });
    await assert.rejects(sdk.markets(), e => e instanceof DataApiError && e.code === code && e.status === status && e.retryAfterMs === 17000);
    assert.equal(calls, 1);
  }
  await assert.rejects(client(async () => new Response("over capacity", { status: 429, headers: { "retry-after": "25" } })).markets(),
    e => e instanceof DataApiError && e.code === "HTTP_ERROR" && e.retryAfterMs === 25000);
});

test("data client handles cancellation timeouts malformed responses and secure URL configuration", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client(async () => { throw Error("must not fetch"); }).markets({}, { signal: abort.signal }), error("ABORTED"));
  const sdk = createOxleyDataClient({ baseUrl: "http://localhost:3020/api/data/v1", chainId: 99801, timeoutMs: 5,
    fetch: async (_, init) => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("late")), 100);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    }) });
  await assert.rejects(sdk.markets(), error("TIMEOUT"));
  await assert.rejects(client(async () => new Response("<html>not JSON</html>")).markets(), error("INVALID_RESPONSE"));
  for (const baseUrl of ["http://external.example", "https://user:password@example.com", "https://example.com/?token=secret"])
    assert.throws(() => createOxleyDataClient({ baseUrl, chainId: 99801 }), error("INVALID_CLIENT_OPTIONS"));
});

test("data client does not silently accept preview payloads or invalid pagination", async () => {
  for (const patch of [{ source: "preview" }, { hasMore: true, nextCursor: null }, { hasMore: undefined, nextCursor: undefined }, { snapshotBlock: "101" }])
    await assert.rejects(client(async () => Response.json(wire("markets", [], patch))).markets(), error("INVALID_RESPONSE"));
});


test("current data rejects an old zero-lag finalized prefix and incomplete freshness evidence",()=>{
  assert.equal(isCurrentData({checkedAt:now,freshness:"fresh"},now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),indexedTimestamp:now-1003} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),latestBlock:null} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),lagBlocks:"1"} as never,now*1000),false);
});
test("platform challenges preserve their identity for JSON and HTML without bypassing protection",async()=>{
  for(const body of [JSON.stringify({error:{code:"challenge"}}),"<html>challenge</html>"]) {
    const sdk=client(async()=>new Response(body,{status:403,headers:{"x-vercel-mitigated":"challenge","retry-after":"30"}}));
    await assert.rejects(sdk.markets(),(e:unknown)=>e instanceof DataApiError&&e.code==="PLATFORM_CHALLENGE"&&e.retryAfterMs===30_000);
  }
});

test("data reads work without AbortSignal static helpers and release their caller listener",async()=>{
  const any=Object.getOwnPropertyDescriptor(AbortSignal,"any")!,timeout=Object.getOwnPropertyDescriptor(AbortSignal,"timeout")!;
  Object.defineProperty(AbortSignal,"any",{configurable:true,value:undefined});
  Object.defineProperty(AbortSignal,"timeout",{configurable:true,value:undefined});
  const caller=new AbortController();let observed:AbortSignal|undefined;
  try {
    const sdk=client(async(_,init)=>{observed=init?.signal??undefined;return Response.json(wire("markets"));});
    assert.equal((await sdk.markets({}, {signal:caller.signal})).resource,"markets");
    caller.abort("navigation");assert.equal(observed?.aborted,false,"completed reads release their caller listener");
  }finally{Object.defineProperty(AbortSignal,"any",any);Object.defineProperty(AbortSignal,"timeout",timeout);}
});

test("data read deadlines fence transports that return after cancellation",async()=>{
  const caller=new AbortController();
  const late=async()=>{await new Promise(resolve=>setTimeout(resolve,25));return Response.json(wire("markets"));};
  const sdk=createOxleyDataClient({baseUrl:"http://localhost/api/data/v1",chainId:99801,timeoutMs:5,fetch:late});
  await assert.rejects(sdk.markets(),error("TIMEOUT"));
  const pending=client(late).markets({}, {signal:caller.signal});caller.abort("navigation");
  await assert.rejects(pending,error("ABORTED"));
});
