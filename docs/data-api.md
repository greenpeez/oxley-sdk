# Public Indexed Data API

Published baseline: `@oxley/sdk@0.5.0-next.4`, exported from `@oxley/sdk/data` (introduced in `0.5.0-next.1`). The local unreleased candidate adds the corrections documented below; it has not been published or deployed.
Public API root: `https://app.oxley.fun/api/data/v1`.
Network: Elysium testnet, chain `99801`, Oxy-USDC. Mainnet is not enabled.
Version `0.5.0-next.0` does not export `/data`. The published baseline described here was the default `latest` release at its recorded publication; legacy consumers can explicitly pin `0.4.1`. This local review does not attest the current package-registry tag.

## Access

Read-only HTTPS JSON, usable from browsers and servers. No API key, wallet,
signature, or RPC is required from builders. Application responses allow all CORS
origins without credentials. Upstream platform mitigation can respond before that
handling, including a 403 challenge without CORS headers. GET and OPTIONS only. The API reuses the approved indexers and their
release, reorg, freshness and capacity checks; it does not create a new ingestion
service or perform quote/portfolio RPC enrichment.

The API belongs on the Elysium application host, `app.oxley.fun`.
`oxley.fun/docs` hosts documentation, not the public data API.

Use a configured API root ending in `/api/data/v1`. No production hostname is
baked into the SDK. HTTP is accepted by the SDK only for localhost development.

```sh
export OXLEY_DATA_API_URL=https://app.oxley.fun/api/data/v1
curl "$OXLEY_DATA_API_URL/auctions?model=cca&limit=20"
```

## Endpoints

| GET path / SDK method | Required parameters | Optional parameters | Result |
| --- | --- | --- | --- |
| `/auctions` / `auctions` | `model` | `dealId`, `q`, `cursor`, `limit` | Current auction catalog, or exact auction |
| `/bids` / `bids` | `model`, `owner`, `dealId` | `cursor`, `limit` | Indexed wallet bid positions for one auction |
| `/auction-activity` / `auctionActivity` | `model`, `dealId` | None | Latest 50 auction events, including submitted bids |
| `/auction-prices` / `auctionPrices` | `model`, `dealId`, `fromBlock`, `toBlock` | None | Up to 1,000 auction clearing-price checkpoints |
| `/markets` / `markets` | None | `dealId`, `q`, `cursor`, `limit` | Reserve-market catalog, or exact active market |
| `/trades` / `trades` | `dealId`, `from`, `to` | `wallet`, `cursor`, `limit` | Paginated finalized executions |
| `/candles` / `candles` | `dealId`, `interval`, `from`, `to` | None | One series of genuine OHLCV candles |
| `/volume` / `volume` | `dealId`, `asOf` | None | Exact 1h, 24h and previous-24h quote volume |

`model` must be `cca` or `bonded-v2`. They are distinct approved auction catalogs,
not alternate names for the same feed. The CCA catalog follows the configured
current listing release; known historical IDs use the existing approved indexer
membership routing. The bonded-v2 source has its own release gate. A disabled
source returns 503, not an empty success. Catalogs are not an all-time, globally
merged archive. Failed auctions can be excluded from discovery; exact-ID lookup
remains available. Use successful auctions plus exact `/markets?dealId=...` to
discover their trading state: the standalone reserve catalog can exclude auctions.

The current public deployment enables `cca`. The separately gated `bonded-v2`
source is not deployed and returns `503 CAPABILITY_NOT_DEPLOYED`. Use the actual
indexed catalog, not an assumption that every newer UI launch model is indexed.
Bid queries require both `owner` and `dealId`; this API does not scan all auctions
or perform RPC reconstruction to assemble a wallet-wide portfolio. Historical
release routes remain subject to the capabilities enabled on their own indexers.

`dealId` is the bytes32 market ID, not its token address. `owner` and `wallet` are
EVM addresses. A catalog `q` is at most 48 UTF-8 bytes or an exact deal ID. Exact
catalog `dealId` cannot be combined with `q`, `cursor`, or `limit`.

Time values are Unix seconds. Trade ranges must be shorter than 90 days; endpoints
include both boundaries. Candle intervals are `1m`, `15m`, `1h`, `1d`; each request
is bounded to 5,000 buckets. A candle is included by bucket start, with the start
rounded down to that interval. Empty buckets are omitted, not filled with fake
zero trades. Auction-price ranges are **indexed event block numbers**, not
timestamps or the auction's virtual checkpoint block. Both bounds are required;
`toBlock - fromBlock` must be at most 100,000 and `toBlock` cannot exceed the
indexed head. Use an auction-activity event's `block` to locate its event range.
Dense checkpoint ranges return an error; split the range rather than dropping data.

## Values And Volume

Monetary amounts, IDs such as bid IDs, Q96 prices, and WAD prices remain decimal
strings. Use BigInt/decimal arithmetic, not Number, for financial computation.
Timestamps and safe block counters in auction/checkpoint rows are numbers; the
envelope's indexed/snapshot blocks and event block fields are decimal strings.
Unsettled auction proceeds/supply totals and the first checkpoint can be null.
Null means unknown/not settled, never zero.

`quoteToken` identifies the actual asset and its six decimals. Testnet uses
Oxy-USDC, not redeemable USDC. Mainnet must use its reviewed canonical USDC
bindings and chain ID. Coin quantities use the coin's own decimals. Preserve raw
price units (`*Q96` and `*Wad`) until applying the protocol's quote/coin decimal
convention; do not format a Q96 value as a dollar amount directly.

Volume is from finalized trade events only, never bid deposits or auction
proceeds. `/volume` returns `volume24hQuoteUnits`, `previous24hQuoteUnits`,
`volume1hQuoteUnits`, `asOf`, and `lastTradeAt`. The current windows are
`[asOf-86400, asOf]` and `[asOf-3600, asOf]`; the previous window is
`[asOf-172800, asOf-86400)`. The adapter uses the indexer's bounded exact-integer
summary, not a sum over a truncated activity page. `asOf` must be at least 172920
and no later than now. An event beyond the indexed head is not yet included.
`volumeUsdcUnits` in each candle is the indexed quote volume for that bucket.
For executions, buy `quoteAmount` is gross input and sell `quoteAmount` is net
output; do not sum them naively to replace the indexed volume series.

## Freshness And Pagination

Every response includes `apiVersion`, `source: "indexed"`, chain/release identity,
`generation`, `indexedBlock`, `indexedBlockHash`, `checkedAt`, `freshness`, and
`quoteToken`. `indexedTimestamp` is supplied where the underlying feed has it.
`checkedAt` is observation time, not the time the API request completed.

The SDK rejects observations older than 180 seconds or over 30 seconds in the
future. A validated delayed complete prefix can still be displayed, explicitly
marked `freshness: "stale"`, `readState: "complete-prefix"`, with `lagBlocks`.
`isCurrentData(response)` is false for it. Recheck freshness while retaining a
response; a previously fresh result does not stay fresh indefinitely. Both rules below
also require `checkedAt`, `indexedTimestamp` and `latestTimestamp` to be recent and a
consistent head (`latestBlock >= indexedBlock`, canonical block hashes). No preview
fixtures or fabricated fallback history are served. Errors must not be shown as
zero volume or empty markets.

### Confirmation: finalized prefix or canonical tip

`confirmation` says how the indexed block relates to finality. Absent or `"finalized-prefix"`:
the index sits exactly on the finalized block, so `isCurrentData` needs `lagBlocks === "0"` and
`finalizedBlock === indexedBlock`, as before. `"canonical-tip"` (current markets, which follow the
chain tip): `indexedBlock` normally lies above `finalizedBlock`, `lagBlocks` is deliberately **omitted**
(it is a finalized-prefix notion, never zero) and `headLagBlocks` / `finalityLagBlocks` keep their meaning.
A tip response is current when `freshness` is `"fresh"`, `finalizedBlock <= indexedBlock`, `lagBlocks` is
absent, the timestamps are within the 180 s / +30 s window and the hashes (`indexedBlockHash`,
`finalizedBlockHash`, `latestBlockHash` when present) are canonical. A tip response is never labelled
stale: the server refuses it with `503 INDEX_STALE` instead. An unknown `confirmation` is never current.
Optional `finalizedBlockHash` and `latestBlockHash` accompany it.

Merged responses add `sources: DataSourceObservation[]`, one observation per contributing feed
(`feed: "current" | "legacy"`, its own `releaseId`, blocks, hashes, times, `freshness`, `confirmation` and
`delayReason`). `isCurrentData` is true only if the envelope **and every source** is current, each under its
own rule: a finalized-prefix source by the prefix rule, a canonical-tip source by the tip rule. Catalog
rows (`Auction`, `IndexedMarket`) then carry `feed` to say which source observed them. Single-market
resources take their feed from `sources`.

Trades may carry `origin: "user" | "reward"` (a protocol reward purchase is not a user's own trade).
Bid `status` is text such as `active` or `exited`; treat unknown values as opaque.

Paginated endpoints return `hasMore` and opaque `nextCursor`. Cursors are opaque `ox1.…` strings: pass the cursor
unchanged with the same filters and fixed `from`/`to`, even after an empty page.
Continue only while `hasMore` is true. Do not decode cursors, combine different
generations, or assume separate resources share a snapshot. On `409 CURSOR_STALE`,
discard that traversal and restart at page one. For a recent activity refresh,
start a new traversal and deduplicate trades by chain/transactionHash/logIndex.
Auction activity is only a latest-50 window, not a complete paginated audit log.

## Errors And Polling

`DataApiError` exposes `code`, HTTP `status`, and optional `retryAfterMs`. Typical
application statuses: 400 invalid/bounded range, 404 unknown route or `MARKET_NOT_FOUND`,
409 `CURSOR_STALE` (restart at page one), 429 capacity limit, 503 `INDEX_STALE` (retry after 5 s,
exposed as `retryAfterMs`), 503 `CAPABILITY_NOT_DEPLOYED` (for example `auction-activity` and
`auction-prices` on current-feed auctions), other 503 unavailable/unapproved source. The client also
rejects invalid schemas, chain/asset mismatches and aborted/timed-out requests.
It sends no cookies or authorization, does not follow redirects, and makes no
automatic retries. Use the per-call `signal` to cancel on navigation.

Start with one poll every 15 seconds for the visible view, not one per card. This
cadence is guidance, not an exemption from upstream DDoS mitigation. A platform
403 can return JSON or HTML and may be opaque to a cross-origin browser.
Never overlap polls. Honor `Retry-After`, add jitter/backoff on errors, pause when
hidden/offline, and refresh the first page instead of crawling all history on
every tick. This is polling, **not a WebSocket stream or a latency SLA**. A server
proxy can fan out a shared result, but retain the original freshness metadata.
Four visible resources polled every 15 seconds are roughly 0.27 requests/second
per viewer before cursor requests. The existing shared capacity limits still
apply; this release does not promise capacity for unbounded third-party fan-out.

## Release Boundary

The application mount is `app/api/data/v1/[resource]/route.ts`, using the existing
server-only worker bindings and capacity credential. Preview/acceptance-token
configurations are refused. No new database, migration, signing key, sponsorship,
financial action, frontend page, or public credential is added.

Testnet server validation remains bound to the existing Elysium testnet release.
The listing indexer exposes its existing bounded bid reader only for an explicitly
selected, approved auction. This does not change its storage, indexing, financial
actions or release authorization. Mainnet needs
approved indexer/contract/USDC configuration and mainnet-specific release
validation; changing the SDK chainId alone does not enable it. Trading calldata
stays in the existing trading client, not in the display-data API.

## Local candidate corrections (25 October 2026; not published or deployed)

The prepared SDK classifies `PLATFORM_CHALLENGE` separately for platform JSON and
HTML responses, including `x-vercel-mitigated: challenge`. A platform response can
arrive before application CORS/error handling; a browser can consequently report
an opaque CORS error. `Retry-After` is a minimum wait, not a promise that mitigation
ends then. No protection bypass or firewall exemption is included.

Read-only Vercel dashboard inspection on 25 October attributed 33 challenges in
the displayed past-day window to **DDoS Mitigation**, including 13 requests on
`/api/data/v1/auctions`. Custom rules were absent, Bot Protection was Off and Attack
Mode was disabled. This identifies the observed mitigation category; it does not
correlate each original reported request without its request ID. A custom WAF
bypass does not override system mitigations. A provider false-positive review,
or a narrowly approved system bypass for a controlled integration's fixed egress,
is separate operational work. Public anonymous access must not be promised a
challenge-free cadence. No platform policy was modified during this inspection.

The standalone SDK's per-read cancellation also works without `AbortSignal.any`
or `AbortSignal.timeout`. It releases its timer and caller listener on completion
and fences late results. It does not polyfill globals or change wallet lifetimes.

`isCurrentData()` now requires canonical indexed hash/block evidence, a matching
finalized block, zero finalized backlog, recent indexed/checked/latest times and
an available non-regressed latest head. All relevant observations must be no more
than 180 seconds old (at most 30 seconds in the future). Missing evidence is not
current. This is display/read freshness, never permission to execute a transaction.

- `lagBlocks` is finalized minus indexed, preserving the existing definition.
- `headLagBlocks` is latest minus indexed.
- `finalityLagBlocks` is latest minus finalized.
- A recently checked, old finalized prefix can have zero `lagBlocks` and still be
  stale. `checkedAt` does not refresh `indexedTimestamp`.

The envelope's `releaseId` identifies the feed; numeric `generation` is its reorg
counter. Neither is a market deployment generation. Additive `feedIdentity` keeps
those facts explicit. `deploymentIdentity` is separate and nullable; canonical
market rows can carry controller/adapter/curve/quote addresses and runtime hashes,
plus their observation block/hash. Unknown deployment release names stay null.
Exact history endpoints may require an exact auction/market lookup to obtain the
binding. Verify those bindings against a reviewed manifest and fresh chain reads
before transaction preparation; do not rename the feed release to make a string
comparison pass. Existing published releases retain their original meaning.

## Resolving An Indexed Market For Trading

Display rows never authorize a transaction. To trade a market from a catalog row, pass its
`dealId` to `createOxleyMarkets().resolveMarket(dealId, { identity })` from the main package, where
`identity` is the row's `deploymentIdentity` when it is present (often it is `null`; then omit it).
A `source: "verified-binding"` identity (with `releaseId` such as `elysium-auctions-gen3-aac49c62c3855f41` or
`elysium-auctions-gen8-969bd0e317da4145`, plus controller, adapter, curve and quote addresses with runtime
hashes) must match the reviewed curve, controller and quote token (`releaseId` is informational and is not
compared), but it is still an HTTP claim: the SDK verifies the runtime hashes through your RPC before preparing
anything. The identity only selects which reviewed curve to ask; the chain must still list the deal as an
active, registered market of that generation, otherwise resolution fails (`IDENTITY_MISMATCH`,
`UNKNOWN_DEPLOYMENT` or `UNSUPPORTED_MARKET`). See [current markets](markets.md). Markets on older,
unreviewed curves (for example the original bonded-v2 launches) appear in indexed catalogs but are
not tradable through this SDK.

