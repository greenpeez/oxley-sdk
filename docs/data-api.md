# Public Indexed Data API

Release: `@oxley/sdk@0.5.0-next.4`, exported from `@oxley/sdk/data` (introduced in `0.5.0-next.1`; data-client runtime unchanged from `0.5.0-next.2`).
Public API root: `https://app.oxley.fun/api/data/v1`.
Network: Elysium testnet, chain `99801`, Oxy-USDC. Mainnet is not enabled.
Version `0.5.0-next.0` does not export `/data`. The current Elysium SDK is the
default `latest` release; legacy consumers can explicitly pin `0.4.1`.

## Access

Read-only HTTPS JSON, usable from browsers and servers. No API key, wallet,
signature, or RPC is required from builders. CORS allows all origins without
credentials. GET and OPTIONS only. The API reuses the approved indexers and their
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
response; a previously fresh result does not stay fresh indefinitely. No preview
fixtures or fabricated fallback history are served. Errors must not be shown as
zero volume or empty markets.

Paginated endpoints return `hasMore` and opaque `nextCursor`. Pass the cursor
unchanged with the same filters and fixed `from`/`to`, even after an empty page.
Continue only while `hasMore` is true. Do not decode cursors, combine different
generations, or assume separate resources share a snapshot. On `409 CURSOR_STALE`,
discard that traversal and restart at page one. For a recent activity refresh,
start a new traversal and deduplicate trades by chain/transactionHash/logIndex.
Auction activity is only a latest-50 window, not a complete paginated audit log.

## Errors And Polling

`DataApiError` exposes `code`, HTTP `status`, and optional `retryAfterMs`. Typical
statuses: 400 invalid/bounded range, 404 unknown route/market, 409 stale cursor,
429 capacity limit, 503 unavailable/stale/unapproved source. The client also
rejects invalid schemas, chain/asset mismatches and aborted/timed-out requests.
It sends no cookies or authorization, does not follow redirects, and makes no
automatic retries. Use the per-call `signal` to cancel on navigation.

Start with one poll every 15 seconds for the visible view, not one per card.
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
