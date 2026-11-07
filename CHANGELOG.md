# Changelog

## 0.6.0-next.3 - 2026-11-07

Gen10 support. Gen10 is the Gen9 contract stack redeployed with one change: the launch controller's net minimum raise is **$30,000**
(Gen8 and Gen9: $50,000), so an auction that clears at its lowest floor starts trading at about a $101,000 market cap instead of
about $168,000. The change is a constructor-only literal, so the runtime ABI, bid rules, curve views, calldata, floor cap and error
codes are Gen9's. Gen10 reuses Gen9's terms registry, so a wallet that accepted the terms on a Gen9 market is already accepted. It is
the generation new auctions launch on; Gen8 and Gen9 markets keep trading, bidding and claiming and are unchanged. USDC (Oxy-USDC on
testnet) stays the only quote and payment asset. This change deploys no contracts and broadcasts no transactions.

- Gen8 family: `GEN8_FAMILY_IDS` is now `gen8`, `gen9`, `gen10`; `DeploymentGeneration` and `Gen8FamilyId` accept `"gen10"`. Each member gains
  `minimumNetRaise` (USDC base units: Gen8 and Gen9 `GEN8_MINIMUM_NET_RAISE` 50,000e6, Gen10 `GEN10_MINIMUM_NET_RAISE` 30,000e6), and
  `gen8MinimumNetRaise(generation)` and `gen8MinimumGrossRaise(generation)` return the net minimum and the controller's
  `minimumGrossRaise()` (`net x 10,000 / 9,900`, rounded down: 50,505,050,505 and 30,303,030,303). Gen10 has Gen9's floor cap
  (`maxFloorPriceWad` 1e21). Manifest validation, the auctions client, Dynamic Bids, curve views and calldata, the opening-surcharge and
  terms rules and revert wording route through the table, so a Gen10 manifest takes the Gen8 code paths with no other change. The
  messages that named the family now say "Gen8, Gen9, or Gen10" (the error codes `GEN8_REQUIRED`, `DYNAMIC_BID_REQUIRED`,
  `UNSUPPORTED_GENERATION`, `INVALID_GENERATION` and the rest keep their names); `decodeOxleyRevert` takes `generation: "gen10"`.
- Bundled manifest: `deployments/elysium-testnet-gen10.json` (`@oxley/sdk/deployments/elysium-testnet-gen10.json`) is
  `elysium-auctions-gen10-1fa4ef2a98fd14ed` (start block 25237151, controller `0xff729e724c54045d04846cde960c3c5ad5e892fd`, curve
  `0x68926b5e1b479c1ba32fe8e87699dfe5cfe7bd91`), mapped from the live deployment record with the Gen8 mapping; its source and sha256 are in
  `docs/live-artifacts.json`. `gen10TestnetDeployment` is exported and is the last entry of `testnetDeployments`, so
  `createOxleyMarkets()` resolves Gen10 markets with no configuration and `client("gen10")` selects it. Its Oxy-USDC pin is Gen8's
  and its terms registry pin is Gen9's. **Gen9's manifest is still not bundled** (`gen9TestnetDeployment` is `undefined`); pass it in
  `createOxleyMarkets({ deployments })` to trade Gen9 markets.
- Verification: verifying any Gen8-family auction deployment now also reads the pinned controller's `minimumRaise()` and
  `minimumGrossRaise()` (the hand-declared fragment `launchMinimumRaiseAbi`, `/abis`, `/auctions`, `/launch`) at the observation block and
  fails closed (`AUCTION_BINDING_MISMATCH`) unless they are the member's own. A $50,000 controller cannot pass as Gen10, nor a $30,000
  one as Gen8 or Gen9; the floor cap is still read for Gen9 and Gen10. Gen8 verification therefore makes two additional reads.
- Launch floor rule (`@oxley/sdk/launch`, pure, no RPC): `floorReachesMinimumRaise(generation, floorPriceWad)`, `minimumRaiseFloor(generation)`
  and `validateLaunchFloor(generation, floorPriceWad)` mirror the hook's registration rule (`floorPriceQ96 x 300M coins >= ceil(gross / 10) x 10 x 2^96`)
  per generation. The lowest floor is 101,010,101,030,162,826,490 on Gen10 (about $0.00010101) and 168,350,168,257,386,965,981 on Gen8 and
  Gen9 (about $0.00016835), so a floor that raises $30,303 to $50,505 gross is accepted on Gen10 and refused on Gen8 and Gen9
  (`FLOOR_BELOW_MINIMUM_RAISE`); Gen9 and Gen10 also refuse a floor above 1e21 (`FLOOR_ABOVE_MAXIMUM`). The launch client still does not
  prepare Gen8-family launches, which use their own creator account. A Gen10 wallet's opening bid ceiling is `ceil(gross / 10)`, $3,030.303031
  (Gen8 and Gen9: $5,050.505051); the SDK keeps reading it from the hook.
- Launch generation: the application launches on the newest generation of the Gen8 family, so Gen10 is the current launch generation and
  Gen9 and Gen8 are trade, bid and claim only. The SDK has no launch default to change; this is documented in `docs/markets.md`,
  `docs/auctions.md`, `docs/launch.md` and the generated comment on `testnetDeployments`, which now names the newest bundled family member.
- Release scripts: `scripts/deployment-manifests.mjs` lists the Gen10 slot (required) and marks the family; `embed-deployments` derives the
  launch-generation comment from the newest present member and states that Gen9 has no manifest; `import-live-manifests` pins the Gen10
  record (path and sha256), maps it with the Gen8 mapping and refuses it unless it names Gen9's terms registry; `check-package` expects every
  required manifest in the archive and exercises Gen10 from a clean install.
- Tests: `test/gen10.test.ts` mirrors the Gen9 suite against a fixture built from the live record (`test/fixtures/gen10-production-record.json`,
  pinned by sha256): manifest mapping, auctions parsing, Dynamic Bids and rebids, the lower opening ceiling, verification (floor cap and
  minimum raise), market resolution, quotes and swaps, the shared terms registry and identity routing. `test/launch-floor.test.ts` covers the floor rule.
  The existing family, floor-cap and manifest tests cover three members.

## 0.6.0-next.2 - 2026-11-04

Adds token details to the data client: name, symbol, description, social links and image for any number of markets. Existing
resources, exports and validation behave as before. This change deploys no contracts and broadcasts no transactions.

- Data API: `data.tokens({ ids })` reads the public `tokens` resource (`GET /api/data/v1/tokens?ids=`, at most 50 IDs per request).
  The client lowercases and de-duplicates the IDs, sends batches of 50 (four requests at a time, no further group after a failure) and
  returns one `IndexedData<TokenInfo>` in the order asked. Its observation is the oldest batch's, so `isCurrentData` never rates the
  merge fresher than its least fresh part. A market the API does not list (unknown, or a retired auction) is absent from `items`:
  compare with the IDs you asked for. A malformed ID, or an empty list, is `INVALID_QUERY` before any request.
- `TokenInfo` (`chainId`, `dealId`, `coin`, `creator`, `name`, `symbol`, `description`, `website`, `x`, `telegram`, `image`,
  `metadataRevision`, `metadataUpdatedAt`), `TokenImage` (`cid`, `url`) and `TokenQuery`. `name` and `symbol` come from the market
  index; a market whose creator has saved nothing has `""` text fields, `image: null` and revision and update time `0`.
- Validation: an item must be one of the requested markets and appear once (`DATA_IDENTITY_MISMATCH`); links are `""` or `https://`,
  the image URL is `https://` (or `http://` on localhost), and the description is at most 2,000 characters (`INVALID_RESPONSE`).
  The fields are creator-written text: render them as text, never as markup.
- Documentation: `docs/data-api.md` (the resource, caching and rate guidance) and the README data section.

Gen9 support. Gen9 is the Gen8 contract stack redeployed unchanged except for the launch controller,
which caps the floor price. It runs beside Gen8; existing Gen8 auctions, manifests, ABIs, bid rules and error codes behave as before.
This change deploys no contracts and broadcasts no transactions.

- Gen8 family: `src/gen8-family.ts` is the one table of generations that share the Gen8 code paths (`GEN8_FAMILY`,
  `GEN8_FAMILY_IDS`, `isGen8Family`, `gen8FamilyMember`, `Gen8FamilyId`). Manifest validation, the auctions client and its
  verification, Dynamic Bids, curve views and calldata, the opening-surcharge and terms rules, revert wording and the launch
  client's refusal route through it instead of comparing `"gen8"`. Each member keeps its own generation id, release-ID prefix and
  manifest file; Gen9 never reuses Gen8's identity.
- `DeploymentGeneration` accepts `"gen9"`. A Gen9 manifest has the Gen8 shape: `generation: "gen9"`, a `termsRegistry` pin, the
  `bidHook` and `exposureHelper` pins and the exact compiled `bidRules` record the SDK mirrors (the Gen8 rules, unchanged). `createOxleyMarkets({ deployments })`
  routes a Gen9 manifest beside Gen8, `client("gen9")` selects it, and error codes such as `GEN8_REQUIRED` and `DYNAMIC_BID_REQUIRED`
  keep their names; their messages now say "Gen8 or Gen9".
- Floor cap: the Gen9 launch controller reverts `FloorPriceAboveMaximum(uint256,uint256)` when the floor exceeds
  `GEN9_MAX_FLOOR_PRICE_WAD` (1e21, in `floorPriceWad` units) and exposes `MAX_FLOOR_PRICE_WAD()`. `decodeOxleyRevert` decodes the
  error into a USDC floor message (`OxleyRevertName` gains `FloorPriceAboveMaximum`; args are the requested floor and the maximum).
  The error and getter are the hand-declared fragment `launchFloorCapAbi` (`/abis`, `/auctions`, `/launch`), because the Gen8-family
  controller ABI is not shipped here; `oxleyRevertAbi` is unchanged. Signature and parameter names (`floorPriceWad`, `maximum`) match the compiled Gen9 controller.
  Verifying a Gen9 auction deployment reads `MAX_FLOOR_PRICE_WAD()` on the pinned controller and fails closed
  (`AUCTION_BINDING_MISMATCH`) unless it is exactly 1e21; Gen8 reads nothing new.
- Manifest plumbing: `@oxley/sdk/deployments/elysium-testnet-gen9.json` is an export, and `gen9TestnetDeployment` is exported. Until the
  reviewed live manifest exists the file is absent, `gen9TestnetDeployment` is `undefined` and `testnetDeployments` stays flat-fee, Gen3,
  Gen8. Adding the file and running `npm run embed` bundles it and appends it to `testnetDeployments`. `scripts/deployment-manifests.mjs`
  is the shared table: `embed-deployments` refuses a manifest whose generation or release-ID prefix does not match its slot,
  `import-live-manifests` maps a Gen9 production record with the Gen8 mapping when given `--gen9-record` and `--gen9-sha256`, and
  `check-package` expects the Gen9 file in the package exactly when it exists.

## 0.6.0-next.1 - 2026-10-29

Reaches every current market (flat-fee, Gen3, Gen8), adds terms acceptance, integrator fees and Gen8
Dynamic Bids. The flat-fee manifest, its calldata, RPC reads and all existing exports behave as before.
This change deploys no contracts and broadcasts no transactions.

- Markets: `createOxleyMarkets({ publicClient, deployments? })` routes `resolveMarket`, `quote`, `prepareSwap`,
  `checkSwap`, `getTradingStatus`, fee swaps and terms across reviewed generations. A deal ID is resolved on chain
  (registry plus curve `market`); `UNSUPPORTED_MARKET`, `AMBIGUOUS_MARKET`, `UNKNOWN_DEPLOYMENT` and
  `IDENTITY_MISMATCH` never fall back to a guess. The data API's `deploymentIdentity` only narrows the candidate.
  `discoverMarkets` pages every generation with resumable cursors.
- Deployments: `deployments/elysium-testnet-gen3.json` (`elysium-auctions-gen3-aac49c62c3855f41`, 13 activated
  markets) and `elysium-testnet-gen8.json` (`elysium-auctions-gen8-969bd0e317da4145`, no active market yet), verified by
  runtime code hash, bundled as `testnetDeployments`. `generation` accepts `"gen3"` and `"gen8"`, which require a
  `termsRegistry` pin (checked against the curve's immutable binding). Gen2 is not bundled: all 14 of its auctions
  failed, so its curve holds no market; its planned-address manifest is unchanged. Bonded-v2 curves are unsupported.
- Quotes and swaps per generation: Gen8 quote views (`quoteBuy(id, amount)`, `quoteSell(id, amount)`), `market()` without
  a reserve asset and the four-argument `sell`; the Gen2+ trading gate now also guards Gen3 and Gen8.
  `Market.generation` and `Quote.openingSurchargeWad` (Gen3/Gen8 buys) are additive. Quote fees already include the
  decaying opening surcharge because they come from the curve's own views.
- Terms: `getTermsStatus`, `prepareAcceptTerms` (unsigned, simulated `acceptTerms`), `buildAcceptTerms`; `checkSwap`
  returns `termsAccepted`/`terms` and refuses to simulate (`TERMS_NOT_ACCEPTED`) before acceptance.
- Integrator fees: `prepareSwapWithFee`, `checkSwapWithFee`, `buildSwapWithFee`, `integratorFeeAmount`,
  `MAX_INTEGRATOR_FEE_BPS` (100). Buys: fee transfer, exact approval, trade of the net amount. Sells: trade, then a fee on
  the guaranteed minimum output. Returns an EIP-5792 `wallet_sendCalls` request and a sequential fallback with its
  non-atomic risk stated. The checker re-quotes and re-derives every call.
- Dynamic Bids (Gen8, `/auctions`): `getDynamicBidLimits`, `prepareDynamicBid`, `prepareDynamicRebid`, `buildDynamicBid`,
  `buildDynamicRebid`, bid-witness encoding and verification, previous-tick derivation, and pure helpers for the
  20 Oxy-USDC minimum, `max(ceil(minimumGrossRaise / 10), others / 9)` ceiling, 30M-token cap, 3 live / 12 total
  bids, 1,000 price levels and the 0.1% accepted-bid fee. `prepareBid` refuses Gen8 (`DYNAMIC_BID_REQUIRED`); the
  auctions client rejects Gen3 and the launch client rejects Gen8 (`UNSUPPORTED_GENERATION`).
- ABIs and evidence: full Gen3 curve, terms registry and Gen8 curve/bid-router/bid-hook ABIs under
  `@oxley/sdk/abis/*`, source and sha256 evidence in `docs/live-artifacts.json`, typed subsets
  (`termsRegistryAbi`, `openingFeeCurveAbi`, `gen8CurveAbi`, `gen8BidRouterAbi`, `gen8BidHookAbi`, `ccaCheckpointAbi`)
  tested against them. `decodeOxleyRevert` also decodes terms, curve-trade and Gen8 bid errors.
- Data API: `isCurrentData` understands `confirmation: "canonical-tip"` responses (fresh, `finalizedBlock <= indexedBlock`, no
  `lagBlocks`, recent timestamps) and judges every `sources[]` entry under its own rule; finalized-prefix rules are unchanged.
  New optional types: `confirmation`, `finalizedBlockHash`, `latestBlockHash`, `DataSourceObservation`/`sources`, `feed` on auctions and
  markets, `origin` on trades. Opaque `ox1.` cursors and the `CURSOR_STALE`, `INDEX_STALE`, `MARKET_NOT_FOUND` and
  `CAPABILITY_NOT_DEPLOYED` errors already pass through unchanged. `resolveMarket({ identity })` also binds a verified-binding
  identity's controller and quote to the reviewed pins.
- Tooling: `npm run test:live:markets` (read-only testnet check), `npm run embed`, `scripts/import-live-manifests.mjs`.

## 0.6.0-next.0 - 2026-10-20

Gen2 auction contract support. Manifests without `generation` keep the flat-fee
behaviour, calldata and RPC reads unchanged.

- Deployment manifests accept optional `generation` (`"flat-fee"` | `"gen2"`),
  `status` and `note`; `deploymentGeneration()` defaults to flat-fee.
- `deployments/elysium-testnet-gen2.json`: Gen2 fork-rehearsal manifest with
  `"status": "planned-fork-addresses"`. Not a live deployment; verification fails
  closed until the contracts exist. The flat-fee testnet manifest is unchanged.
- Full Gen2 ABIs under `@oxley/sdk/abis/gen2/*.json` with source commit and
  sha256 evidence in `docs/gen2-artifacts.json`; typed subsets `gen2CreatorAccountAbi`,
  `gen2AuctionControllerAbi`, `breadthBidHookAbi`, `gen2CurveAbi`, `oxleyRevertAbi`.
- Launch: `auctionDurationBounds`, `auctionDurationBlocks`, `sampleSecondsPerBlock`;
  Gen2 `buildAuctionLaunch`/`prepareLaunch` encode the exact-duration launch from a
  supplied or sampled block rate, checked against on-chain `durationBounds`.
- Auctions: `getBidAllowance` and Gen2 `prepareBid` checks for the per-wallet cap
  and creator exclusion (`WALLET_CAP_EXCEEDED`, `CREATOR_BID_NOT_ALLOWED`).
- Trading: `getTradingStatus`; Gen2 quotes and swaps fail closed with `TRADING_NOT_OPEN`.
- `decodeOxleyRevert` decodes Gen2 rule reverts into short messages.
- `OxleyError` gains optional structured `details`.

This change deploys no contracts and broadcasts no transactions. Mainnet bindings remain pending.

## 0.5.0-next.4 - 2026-10-16

- Add the `/launch` module: verified auction launch preparation, creator-account
  ABIs, exact launch-fee approvals, resumable stages and restart recovery.

## 0.5.0-next.3 - 2026-10-16

- Documentation-only release; no runtime, ABI, deployment-profile or dependency changes.
- Correct trading versus auction-client scope and document independent RPC quotes,
  locally computed minimums, approval sequencing and unknown-outcome recovery.
- Add verified real testnet buy/sell transactions, output floors, balances and test limitations.
- Synchronize provider, exchange, frontend-data and auction guidance with public Builders docs.

Published to `latest`. Mainnet bindings and provider acceptance remain pending.
Earlier version archives and their historical validation records are unchanged.

## 0.5.0-next.2 - 2026-10-16

- Full controller, fee-aware bid router, adapter and CCA auction ABI JSON exports.
- Separate `/auctions` module with unsigned bid, token-claim and full/partial refund builders.
- Runtime/binding verification, on-chain bid fees, exact quote-token approvals and simulations.
- Explicit original-owner payouts, checkpoint hints and claim-after-exit workflow.
- Auction unit/ABI tests, real-bytecode local execution tests, and read-only testnet verification.
- Pin the existing data freshness test clock to remove timing-dependent boundary failures.

No contract or application deployment, funded test, or change to npm `latest`.
Mainnet bindings remain pending; the new helpers do not support older auction releases.

## 0.5.0-next.1 - 2026-10-16

- Public indexed data client, eight data resources, freshness checks and builder documentation.

## 0.5.0-next.0 - 2026-10-14

Initial standalone Elysium integration release for aggregators and exchanges.

- Active auction-market discovery and block-pinned on-chain quotes.
- Unsigned buy/sell calldata, exact approvals and optional funded simulation.
- Optional 0x BASIC action encoding without a provider-specific callback.
- Full contract ABIs, Solidity interface, testnet runtime pins and mainnet template.
- Reproducible unit, ABI, package-consumer and local EVM settlement tests.

This release uses the `next` channel. It does not replace the legacy `0.4.1`
`latest` release or preserve that release's `/release` and `/evm` API.
Mainnet deployment details and provider route acceptance remain external launch
requirements. Routed buying rewards identify the immediate executor, not its end user.
