# Indexed Data Validation

Verification for `0.5.0-next.1` (2026-10-16). The data client is separate from
trading calldata and this verification submits no funded transactions.

- SDK unit suite: **21 passing tests**, covering existing trading cases plus data methods, exact integer/null
  preservation, both auction models, opaque/empty-page cursors, delayed prefixes,
  expired observations, chain/asset/market mismatches, retry metadata, cancellation,
  deadlines, invalid JSON, preview rejection and invalid pagination.
- Server checks: **34 passing tests**, covering all eight route mappings, parameter/range bounds, read-only
  methods, credential-free CORS, caller credential stripping, preview/acceptance
  refusal, cooldown/error handling, release pin enforcement, indexed-only transport,
  current listing-source routing and correct scoped quote identity.
- TypeScript: SDK source/tests and application checks pass; production Next.js
  build succeeds. No whole-repository acceptance claim is made.
- Local HTTP contract exercise: compiled SDK through the real public adapter and
  indexed transport, all eight resources and both auction models, with fixture
  indexer responses. This is not a real-network indexing or latency test.
- Packaged artifact: clean consumer install, ESM import, TypeScript compile, and
  file allowlist verification including the new `/data` export and builder guide.

The live checks use existing approved CCA records, not synthetic trades or newly
funded bids. The bounded bid-reader route was enabled in the existing listing
indexer with its other module bytes, settings, schedules, bindings and approval
records preserved. No database migration or approval rewrite was required.

Checkpoint queries use event block numbers, not the auction's virtual checkpoint
counter. The final API requires explicit ranges of at most 100,000 blocks. Bid
queries require a specific auction and owner; wallet-wide scans are not enabled.
Membership lookup cooldowns are preserved as `Retry-After` instead of swallowed.

Unit tests cover 429 handling; this release does not deliberately exhaust the
shared live capacity or claim a load/latency SLA. An unavailable source is not
reported as an empty success. Mainnet requires its own reviewed bindings and
release validation.

## Public Feed Verification

On 2026-10-16, the compiled SDK passed a 19-request read-only check against both
the staged release and `https://app.oxley.fun/api/data/v1` after promotion:

- All eight resources parsed successfully against actual indexed records.
- Five CCA auctions were discovered; auction and trade cursors were followed.
- A known auction returned its real wallet bid, checkpoint and active market.
- Nonempty trade history and 39 genuine hourly candles were returned, together
  with the indexer's exact volume summary. An empty reserve catalog was also valid.
- Invalid query, missing route and write requests returned 400, 404 and 405;
  credential-free OPTIONS returned 204. The disabled `bonded-v2` source returned
  `503 CAPABILITY_NOT_DEPLOYED` rather than an empty catalog.
- A separate browser at `https://example.com` fetched the public auction feed
  with credentials omitted and received a successful CORS response.

The successful public pass used fresh observations. During earlier verification,
the source also emitted delayed complete prefixes and temporary unavailable
responses while catching up; these remain visible to consumers. This is indexed
testnet data, not a guarantee of an always-current chain head or mainnet coverage.
