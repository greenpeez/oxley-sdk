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


test("current data rejects an old zero-lag finalized prefix and incomplete freshness evidence",async t=>{
  assert.equal(isCurrentData({checkedAt:now,freshness:"fresh"},now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),indexedTimestamp:now-1003} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),latestBlock:null} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),lagBlocks:"1"} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),indexedTimestamp:now-180} as never,now*1000),true);
  assert.equal(isCurrentData({...wire("markets"),indexedTimestamp:now-181} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),latestTimestamp:now-181} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),latestBlock:"99"} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),finalizedBlock:"101"} as never,now*1000),false);
  assert.equal(isCurrentData({...wire("markets"),indexedBlockHash:"invalid"} as never,now*1000),false);
  const recorded={...wire("markets"),indexedBlock:"16994530",finalizedBlock:"16994530",indexedTimestamp:1_793_105_720,
    checkedAt:1_793_106_241,latestBlock:"17001411",latestTimestamp:1_793_106_241};
  assert.equal(isCurrentData(recorded as never,1_793_106_241_000),false);
  assert.equal(isCurrentData({...recorded,checkedAt:recorded.checkedAt+30,latestTimestamp:recorded.latestTimestamp+30} as never,
    1_793_106_271_000),false);
  t.mock.timers.enable({apis:["Date"],now:1_793_106_241_000});
  const page=await client(async()=>Response.json(recorded)).markets();
  assert.equal(page.indexedTimestamp,1_793_105_720);assert.equal(page.freshness,"fresh");
  assert.equal(isCurrentData(page),false,"the SDK guard independently rejects the incorrect upstream freshness label");
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

const token = (digit: string, over: Record<string, unknown> = {}) => ({ chainId: 99801, dealId: `0x${digit.repeat(64)}`, coin: address, creator: owner,
  name: `Token ${digit}`, symbol: `T${digit}`, description: "", website: "", x: "", telegram: "", image: null, metadataRevision: 0, metadataUpdatedAt: 0, ...over });
const saved = { description: "About it", website: "https://example.test/", x: "https://x.com/example", telegram: "https://t.me/example",
  image: { cid: "bafkrei" + "a".repeat(52), url: "https://app.oxley.fun/api/elysium/token-images?artwork=cid&deal=0x1" }, metadataRevision: 3, metadataUpdatedAt: now - 60 };
const manyIds = (count: number) => Array.from({ length: count }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`);
/** A token API that knows every id except the ones in `unknown`, and records each request's ids. */
function tokenApi(unknown: string[] = [], observe: (ids: string[], at: number) => Record<string, unknown> = () => ({})) {
  const requests: string[][] = [];
  const transport: typeof fetch = async input => {
    const url = new URL(String(input)), asked = url.searchParams.get("ids")!.split(",");
    assert.equal(url.pathname.split("/").at(-1), "tokens"); assert.deepEqual([...url.searchParams.keys()], ["ids"]);
    requests.push(asked);
    return Response.json(wire("tokens", asked.filter(id => !unknown.includes(id)).map(id => token(id[2]!, { dealId: id })), { hasMore: undefined, nextCursor: undefined, ...observe(asked, requests.length) }));
  };
  return { requests, transport };
}

test("data client reads tokens with their text, links and image, and empty fields for a market with no saved details", async () => {
  const sdk = client(async input => {
    assert.equal(new URL(String(input)).searchParams.get("ids"), `${id},0x${"4".repeat(64)}`);
    return Response.json(wire("tokens", [token("1", saved), token("4")], { hasMore: undefined, nextCursor: undefined }));
  });
  const page = await sdk.tokens({ ids: [id, `0x${"4".repeat(64)}`.toUpperCase().replace("0X", "0x")] });
  assert.deepEqual(page.items.map(item => item.name), ["Token 1", "Token 4"]); assert.equal(page.resource, "tokens");
  assert.equal(page.items[0]?.image?.cid, saved.image.cid); assert.equal(page.items[0]?.metadataRevision, 3); assert.equal(page.items[0]?.telegram, "https://t.me/example");
  assert.deepEqual([page.items[1]?.description, page.items[1]?.website, page.items[1]?.x, page.items[1]?.telegram, page.items[1]?.image, page.items[1]?.metadataRevision],
    ["", "", "", "", null, 0]);
});

test("data client splits more than 50 token IDs into batches, merges them in order and reports the markets the API left out", async () => {
  const ids = manyIds(130), missing = [ids[3]!, ids[60]!, ids[129]!], api = tokenApi(missing);
  const page = await client(api.transport).tokens({ ids: [...ids, ...ids.slice(0, 10)] });
  assert.deepEqual(api.requests.map(batch => batch.length), [50, 50, 30], "repeats are read once, 50 per request");
  assert.deepEqual(page.items.map(item => item.dealId), ids.filter(value => !missing.includes(value)));
  assert.deepEqual(ids.filter(value => !page.items.some(item => item.dealId === value)), missing);
  assert.equal(page.items.length, 127); assert.equal(page.resource, "tokens");
  const one = await client(tokenApi().transport).tokens({ ids: manyIds(50) });
  assert.equal(one.items.length, 50);
});

test("data client reads token batches a few at a time and stops at the first failure", async () => {
  let running = 0, peak = 0, calls = 0;
  const slow: typeof fetch = async input => {
    calls++; running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 5)); running--;
    const asked = new URL(String(input)).searchParams.get("ids")!.split(",");
    return Response.json(wire("tokens", asked.map(value => token(value[2]!, { dealId: value })), { hasMore: undefined, nextCursor: undefined }));
  };
  assert.equal((await client(slow).tokens({ ids: manyIds(50 * 9) })).items.length, 450);
  assert.equal(peak, 4); assert.equal(calls, 9);
  calls = 0;
  const failing: typeof fetch = async () => { calls++; return Response.json({ error: "API_CAPACITY_EXCEEDED" }, { status: 429, headers: { "retry-after": "9" } }); };
  await assert.rejects(client(failing).tokens({ ids: manyIds(50 * 9) }), e => e instanceof DataApiError && e.code === "API_CAPACITY_EXCEEDED" && e.retryAfterMs === 9000);
  assert.equal(calls, 4, "later batches are not started once a batch has failed");
});

test("merged token pages carry the oldest observation, so a stale batch is never hidden by a fresh one", async () => {
  const ids = manyIds(60), api = tokenApi([], (_asked, call) => ({ checkedAt: call === 1 ? now : now - 40, indexedBlock: call === 1 ? "100" : "90", latestBlock: "102" }));
  const page = await client(api.transport).tokens({ ids });
  assert.equal(page.items.length, 60); assert.equal(page.checkedAt, now - 40); assert.equal(page.indexedBlock, "90");
  const expired = tokenApi([], (_asked, call) => ({ checkedAt: call === 2 ? now - 181 : now }));
  await assert.rejects(client(expired.transport).tokens({ ids }), error("STALE_OBSERVATION"));
});

test("data client refuses token IDs it cannot send and answers that name other markets, repeat one, or carry unsafe links", async () => {
  const unused: typeof fetch = async () => { throw Error("must not fetch"); };
  for (const ids of [[], ["0x12"], [id.slice(0, -1)], ["not-an-id"], [`${id},${id}`], [7 as never]])
    await assert.rejects(client(unused).tokens({ ids }), error("INVALID_QUERY"), JSON.stringify(ids));
  await assert.rejects(client(unused).tokens(undefined as never), error("INVALID_QUERY"));
  const answer = (items: unknown[]) => client(async () => Response.json(wire("tokens", items, { hasMore: undefined, nextCursor: undefined }))).tokens({ ids: [id] });
  await assert.rejects(answer([token("2")]), error("DATA_IDENTITY_MISMATCH")); // another market than the one asked for
  await assert.rejects(answer([token("1"), token("1")]), error("DATA_IDENTITY_MISMATCH"));
  for (const bad of [{ image: { cid: "bafk", url: "javascript:alert(1)" } }, { image: { cid: "", url: "https://app.oxley.fun/x" } }, { image: { cid: "bafk", url: "http://app.oxley.fun/x" } },
    { image: "https://app.oxley.fun/x" }, { website: "javascript:alert(1)" }, { website: "http://example.test/" }, { x: 5 }, { description: "x".repeat(2001) },
    { name: 5 }, { symbol: null }, { dealId: "0x12" }, { coin: "0x12" }, { chainId: 0 }, { metadataRevision: -1 }, { metadataUpdatedAt: "1" }])
    await assert.rejects(answer([token("1", bad)]), error("INVALID_RESPONSE"), JSON.stringify(bad));
  const local = createOxleyDataClient({ baseUrl: "http://localhost:3020/api/data/v1", chainId: 99801, quoteAsset: address,
    fetch: async () => Response.json(wire("tokens", [token("1", { image: { cid: "bafk", url: "http://localhost:3020/api/elysium/token-images?artwork=a&deal=b" } })], { hasMore: undefined, nextCursor: undefined })) });
  assert.equal((await local.tokens({ ids: [id] })).items.length, 1);
  const tooMany = wire("tokens", manyIds(51).map(value => token(value[2]!, { dealId: value })), { hasMore: undefined, nextCursor: undefined });
  await assert.rejects(client(async () => Response.json(tooMany)).tokens({ ids: manyIds(50) }), error("INVALID_RESPONSE"));
});

test("a retired or unavailable tokens answer surfaces as a typed error and cancellation reaches every batch", async () => {
  for (const [status, code] of [[410, "AUCTION_RETIRED"], [503, "DATA_UNAVAILABLE"], [400, "INVALID_QUERY"]] as const)
    await assert.rejects(client(async () => Response.json({ error: code }, { status, headers: { "retry-after": "5" } })).tokens({ ids: [id] }),
      e => e instanceof DataApiError && e.code === code && e.status === status);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client(async () => { throw Error("must not fetch"); }).tokens({ ids: manyIds(120) }, { signal: abort.signal }), error("ABORTED"));
});
