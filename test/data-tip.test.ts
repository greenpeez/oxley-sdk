import assert from "node:assert/strict";
import test from "node:test";
import { createOxleyDataClient, DataApiError, isCurrentData, type DataSourceObservation } from "../src/data.js";

const hash = `0x${"2".repeat(64)}`, address = `0x${"3".repeat(40)}` as const, owner = `0x${"4".repeat(40)}` as const;
const id = `0x${"1".repeat(64)}` as const, now = Math.floor(Date.now() / 1000), at = (seconds: number) => seconds * 1000;
/** A canonical-tip observation: indexed above the finalized block, no `lagBlocks`. */
const tip = (extra: Record<string, unknown> = {}) => ({ freshness: "fresh", confirmation: "canonical-tip", checkedAt: now, indexedTimestamp: now,
  indexedBlock: "100", indexedBlockHash: hash, finalizedBlock: "95", finalizedBlockHash: hash, latestBlock: "100", latestBlockHash: hash, latestTimestamp: now, ...extra });
/** A finalized-prefix observation: the index sits exactly on the finalized block. */
const prefix = (extra: Record<string, unknown> = {}) => ({ freshness: "fresh", checkedAt: now, indexedTimestamp: now, indexedBlock: "100",
  indexedBlockHash: hash, finalizedBlock: "100", lagBlocks: "0", latestBlock: "102", latestTimestamp: now, ...extra });
const current = (value: unknown, time = at(now)) => isCurrentData(value as never, time);

test("a canonical-tip response is current when fresh, finalized is not ahead, and lagBlocks is absent", () => {
  assert.equal(current(tip()), true);
  assert.equal(current(tip({ finalizedBlock: "100" })), true);
  for (const patch of [{ lagBlocks: "5" }, { lagBlocks: "0" }, { finalizedBlock: "101" }, { finalizedBlock: undefined }, { finalizedBlock: "x" }, { freshness: "stale" },
    { latestBlock: "99" }, { latestBlock: null }, { indexedBlockHash: "0x1" }, { finalizedBlockHash: "bad" }, { latestBlockHash: "bad" }, { indexedBlock: undefined }]) {
    assert.equal(current(tip(patch)), false, JSON.stringify(patch));
  }
});
test("every timestamp of a tip response is held to the 180 s / +30 s window", () => {
  for (const key of ["checkedAt", "indexedTimestamp", "latestTimestamp"]) {
    assert.equal(current(tip({ [key]: now - 180 })), true, `${key} at the edge`);
    assert.equal(current(tip({ [key]: now - 181 })), false, `${key} too old`);
    assert.equal(current(tip({ [key]: now + 30 })), true, `${key} at the future edge`);
    assert.equal(current(tip({ [key]: now + 31 })), false, `${key} too far ahead`);
    assert.equal(current(tip({ [key]: undefined })), false, `${key} missing`);
  }
  assert.equal(current(tip(), at(now + 181)), false, "retained data stops being current");
});
test("finalized-prefix rules are unchanged, and a tip-shaped body without the marker is not mistaken for current", () => {
  assert.equal(current(prefix()), true);
  assert.equal(current(prefix({ confirmation: "finalized-prefix" })), true);
  assert.equal(current(prefix({ lagBlocks: "1" })), false);
  assert.equal(current(prefix({ lagBlocks: undefined })), false, "no lagBlocks without the tip marker");
  assert.equal(current(prefix({ finalizedBlock: "95" })), false);
  assert.equal(current(prefix({ confirmation: "canonical-tip" })), false, "a prefix body fails the tip rule: lagBlocks present");
  assert.equal(current(tip({ confirmation: "mystery" })), false, "an unknown confirmation mode is never current");
});
test("every source of a merged response is current under its own rule", () => {
  const legacy = { feed: "legacy", ...prefix() }, fresh = { feed: "current", ...tip() };
  assert.equal(current(tip({ sources: [fresh, legacy] })), true);
  assert.equal(current(tip({ sources: [] })), true);
  assert.equal(current(prefix({ sources: [legacy, fresh] })), true);
  assert.equal(current(tip({ sources: [fresh, { ...legacy, lagBlocks: "5", freshness: "stale" }] })), false, "a delayed legacy source");
  assert.equal(current(tip({ sources: [{ ...fresh, lagBlocks: "0" }] })), false, "a tip source that states lagBlocks");
  assert.equal(current(tip({ sources: [{ ...fresh, checkedAt: now - 181 }] })), false);
  assert.equal(current(tip({ sources: [{ ...legacy, finalizedBlock: "95" }] })), false, "a prefix source judged by the prefix rule");
  assert.equal(current(tip({ sources: "nope" })), false);
  assert.equal(current(tip({ sources: [null] })), false);
  assert.equal(current(tip({ freshness: "stale", sources: [fresh] })), false, "the envelope itself must also be current");
});
test("a finalized prefix proven to sit on the finalized head may be as old as the 3600 s finality budget; unproven ones keep 180 s", () => {
  const old = now - 900, proven = (extra: Record<string, unknown> = {}) => prefix({ indexedTimestamp: old, finalizedBlockHash: hash, finalizedTimestamp: old, ...extra });
  assert.equal(current(proven()), true, "fifteen minutes behind on the finalized head is current");
  assert.equal(current(tip({ sources: [{ feed: "current", ...tip() }, { feed: "legacy", ...proven() }] })), true, "the merged API's legacy source");
  assert.equal(current(proven({ indexedTimestamp: now - 3601, finalizedTimestamp: now - 3601 })), false, "beyond the finality stall budget");
  assert.equal(current(proven({ finalizedBlockHash: `0x${"9".repeat(64)}` })), false, "a different finalized hash proves nothing");
  assert.equal(current(proven({ finalizedTimestamp: old + 1 })), false, "a different finalized timestamp proves nothing");
  assert.equal(current(prefix({ indexedTimestamp: old })), false, "without the finalized-head proof the 180 s bound applies");
  assert.equal(current(proven({ checkedAt: now - 181 })), false, "the check time keeps its 180 s bound");
  assert.equal(current(proven({ latestTimestamp: now - 181 })), false, "the head time keeps its 180 s bound");
});
const envelope = (resource: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ apiVersion: "1", source: "indexed", resource, chainId: 99801,
  releaseId: "example", candidateHash: hash, bindingFingerprint: hash, generation: 0, ...tip(), hasMore: false, nextCursor: null,
  quoteToken: { address, symbol: "Oxy-USDC", decimals: 6 }, items, ...extra });
const client = (body: unknown, status = 200, headers: Record<string, string> = {}) => createOxleyDataClient({ baseUrl: "https://data.example/api/data/v1", chainId: 99801,
  quoteAsset: address, fetch: async () => Response.json(body, { status, headers }) });

test("the client returns tip envelopes with sources, feeds, trade origins, exited bids and verified-binding identities intact", async () => {
  const identity = { chainId: 99801, source: "verified-binding", releaseId: "elysium-auctions-gen3-aac49c62c3855f41", observedBlock: "100", observedBlockHash: hash,
    controller: { address, runtimeCodeHash: hash }, adapter: { address, runtimeCodeHash: hash }, curve: { address, runtimeCodeHash: hash }, quote: { address, runtimeCodeHash: hash } };
  const sources: DataSourceObservation[] = [{ feed: "current", ...tip() } as never, { feed: "legacy", ...prefix() } as never];
  const market = { dealId: id, mode: "reserve", coin: address, creator: owner, name: "Example", symbol: "TEST", launchedAt: now - 100, spotPriceWad: "5",
    latestTradeAt: null, quoteAsset: address, quoteSymbol: "Oxy-USDC", feed: "current", deploymentIdentity: identity };
  const page = await client(envelope("markets", [market], { sources, deploymentIdentity: null })).markets();
  assert.equal(page.confirmation, "canonical-tip"); assert.equal(page.lagBlocks, undefined); assert.equal(page.finalizedBlockHash, hash);
  assert.equal(page.items[0]?.feed, "current"); assert.equal(page.items[0]?.deploymentIdentity?.source, "verified-binding");
  assert.deepEqual(page.sources?.map(source => source.feed), ["current", "legacy"]);
  assert.equal(isCurrentData(page), true);
  const trade = { side: "buy", trader: owner, coinAmount: "1", quoteAmount: "2", feeAmount: "0", timestamp: now, transactionHash: hash, blockNumber: "9", logIndex: 0, origin: "reward" };
  assert.equal((await client(envelope("trades", [trade])).trades({ dealId: id, from: now - 10, to: now })).items[0]?.origin, "reward");
  const bid = { dealId: id, auction: address, bidId: "1", owner, maxPriceQ96: "5", amountUnits: "5", status: "exited", tokensFilled: "0", refundedUnits: "5", quoteAsset: address };
  assert.equal((await client(envelope("bids", [bid], { model: "cca" })).bids({ model: "cca", owner, dealId: id })).items[0]?.status, "exited");
});
test("opaque ox1. cursors pass through untouched and the new API errors keep their code, status and retry delay", async () => {
  const cursor = "ox1.eyJ2IjoxfQ==&x";
  const sdk = createOxleyDataClient({ baseUrl: "https://data.example/api/data/v1", chainId: 99801, quoteAsset: address, fetch: async input => {
    assert.equal(new URL(String(input)).searchParams.get("cursor"), cursor);
    return Response.json(envelope("markets", [], { hasMore: true, nextCursor: `${cursor}2` }));
  } });
  assert.equal((await sdk.markets({ cursor })).nextCursor, `${cursor}2`);
  const failures: [number, string, Record<string, string>, number | undefined][] = [[409, "CURSOR_STALE", {}, undefined], [503, "INDEX_STALE", { "retry-after": "5" }, 5000],
    [404, "MARKET_NOT_FOUND", {}, undefined], [503, "CAPABILITY_NOT_DEPLOYED", {}, undefined]];
  for (const [status, code, headers, retry] of failures) {
    await assert.rejects(client({ error: code }, status, headers).markets(), (error: unknown) =>
      error instanceof DataApiError && error.code === code && error.status === status && error.retryAfterMs === retry, code);
  }
});
