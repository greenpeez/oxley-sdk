# Changelog

## 0.7.0-next.1 - 2026-11-08

Adds the Gen10 launch client and the full compiler ABIs of every Gen10 contract the SDK touches, and corrects the curve ABI, which was an earlier build's. Still Gen10 only.
No contract is deployed and no transaction is broadcast by this change. **Breaking for hand-written manifests:** `parseDeployment` now requires `launchBindings`.

### Added

- **Launch client.** `createOxleyLaunchClient({ publicClient, deployment })` from `@oxley/sdk/launch` prepares a Gen10 launch as unsigned, simulated transactions, one step
  at a time: `prepareLaunch(input)` returns the next of `terms` (only while the terms registry enforces acceptance), `setup` (factory `createAccountForDraft`), `reset` and
  `approve` (the 1.5 USDC launch fee, approved **to the creator account**), and `launch` (`launchAuctionWithCommitmentAndExactDuration` on the creator account), then
  `complete` with the launch read back; `getLaunch({ owner, draftSalt, beneficiary? })` reads it back at any time (creator account, coin, auction, end block, exact-duration
  schedule, bond held and refundable); `verifyDeployment()` verifies the whole launch graph. Each preparation verifies the auction graph and the launch pins at one block (code
  hash of the factory, entry controller and bond escrow; their bindings; `launchFee()` and `CREATOR_DEPOSIT()` against the manifest; the controller's 14,400 to 72,000 blocks an hour),
  applies `validateLaunchFloor` before any read, checks ticker, deal id, effective floor, terms standing, balances and nonce, and simulates the step from the owner and estimates its gas.
  Failures are `OxleyError` codes: `SIMULATION_FAILED` (with `details.stage` and the decoded `details.revert`; an RPC URL is never in the message), `INSUFFICIENT_QUOTE`,
  `INSUFFICIENT_BOND`, `INSUFFICIENT_GAS`, `GAS_PRICE_TOO_HIGH`, `TICKER_UNAVAILABLE`, `DEAL_ID_USED`, `LAUNCH_PAUSED`, `LAUNCH_BINDING_MISMATCH`, `LAUNCH_COST_MISMATCH`,
  `DURATION_BOUNDS_MISMATCH`, `CREATOR_BINDING_MISMATCH` and the rest listed in [docs/launch.md](docs/launch.md).
- **Native value, as the contracts implement it.** Only the `launch` step carries value: exactly the 0.5 HYPE operating bond (`deployerBondWei`), which the controller requires and the
  bond escrow holds for the auction's delivery and refund gas; the owner also pays the gas of every step, and the launch step is refused above the 1 gwei the escrow accepts and carries the
  `gasPrice` it was simulated at. The launch fee and everything else is USDC (Oxy-USDC on testnet). There is no sponsorship, no USDC-to-HYPE conversion and no HYPE fee, bid or trade option.
- **Offline builders and helpers** from `@oxley/sdk/launch`: `buildCreatorAccount`, `buildLaunchApprovals`, `buildAuctionLaunch` (returns the bond as `value`), `launchDealId` (the
  controller's `dealIdFor`, checked against the controller on every preparation), `newDraftSalt`, `validateAuctionLaunch`, and the exact-duration helpers `auctionDurationBounds`,
  `auctionDurationBlocks`, `sampleSecondsPerBlock`, `AUCTION_MIN_BLOCKS_PER_HOUR` (14,400), `AUCTION_MAX_BLOCKS_PER_HOUR` (72,000) and `BLOCK_RATE_SAMPLE_BLOCKS`; `buildAcceptTerms` is re-exported.
  Types: `AuctionLaunchInput`, `LaunchStage`, `LaunchTransaction`, `LaunchRpcClient`, `LaunchIdentity`, `LaunchState`, `OxleyLaunchClient`.
- **Manifest `launchBindings`:** the creator account factory, entry controller and bond escrow (address and runtime code hash), `launchFeeBaseUnits` (`"1500000"`) and `deployerBondWei`
  (`"500000000000000000"`). `deployments/elysium-testnet.json` has them from the live record; `deployments/mainnet.template.json` has placeholders (the bond, a constant of the contracts, is filled in).
  `parseDeployment` validates them (`LAUNCH_BINDINGS_REQUIRED`, `INVALID_LAUNCH_COST`, `INVALID_BOND`) and requires twelve distinct addresses. The importer maps them from the record.
- **Full compiler ABIs** under `@oxley/sdk/abis/`: `auction-controller.json`, `adapter.json`, `registry.json`, `exposure-helper.json`, `creator-account.json`, `creator-account-factory.json`,
  `bond-escrow.json` and `entry-controller.json`. With the curve, bid router, bid hook, terms registry and CCA that is every Oxley contract in the manifest except the Oxy-USDC token, which
  is not an Oxley build. The typed ABI subsets that mirror them are now tested against them (the controller, adapter and registry subsets had no compiled check before):
  `auctionControllerAbi`, `launchFloorCapAbi`, `launchMinimumRaiseAbi`, `launchControllerAbi`, `auctionAdapterAbi`, `launchFloorAbi`, `registryAbi`, `creatorAccountFactoryAbi`,
  `creatorAccountAbi`, `launchEntryAbi` and `launchBondAbi` (the last five are new exports of `@oxley/sdk/launch` and `@oxley/sdk/abis`).
- **Proof that the ABIs are the deployed build's.** `docs/live-artifacts.json` now records the compiler job the deployment record names (`compiledGraphSha256` `2b7ad321...`, solc 0.8.26, Cancun,
  optimizer 200, no metadata hash), the source commit, and per contract the ABI hash, the build's creation-code and runtime-template keccak256, the immutable slots and the pinned runtime hash.
  The importer refuses an ABI unless the compiled graph hashes to the record's identity, all 109 of its sources are unchanged, and the forge artifact reproduces the graph's creation code,
  runtime template, ABI and immutable slots. `npm run test:live:abis` (`scripts/check-abis-testnet.ts`) compares live chain code with the templates: with the immutable slots zeroed, all eleven
  pinned contracts and a creator account created by the factory hash to the published build, and the pinned contracts hash to the manifest's pins unmasked. Run against Elysium testnet at block
  26,268,297: 12 of 12 match. The exposure helper and the entry controller have no immutables, so their templates equal their pins with no chain read.
- **Revert decoding** names the launch rules (`TickerUnavailable`, `InvalidTicker`, `ReservedTicker`, `InvalidListingCommitment`, `InvalidDurationBlocks`, `InvalidRequestedHours`,
  `FixtureLaunchOnly`, `NewEntriesPaused`, `GasPriceTooHigh`, `NeedsFunding`) and the curve's `TradeMoveLimit`.
- `test:live:launch` also verifies the launch graph live, checks the controller's `LAUNCH_NAMESPACE` and `dealIdFor` against `launchDealId`, and prepares a launch for an unfunded wallet, which must
  be refused with `INSUFFICIENT_QUOTE` after every chain read has succeeded (`OXLEY_LAUNCH_OWNER` and `OXLEY_LAUNCH_SALT` read back an existing launch).

### Fixed

- **`abis/curve.json` and `curveAbi.market` were the Gen8 build's.** The deployed Gen10 curve (the Gen9 launch-scaled curve) returns `priceScaleWad` between `priceOffsetWad` and `curveInventory` in
  `market()` and has a `TradeMoveLimit()` error; the shipped ABI had neither. The SDK only read the four leading fields of `market()` (`coin`, `creator`, `activatedAt`, `active`), which sit before the
  difference, so no quote or swap was affected, but a caller decoding the rest with the SDK's ABI got `curveInventory` and `curveCapital` shifted by one. The router, hook and terms registry ABIs were
  already identical to the Gen10 build; the curve is the only file that changed.

### Changed

- `parseDeployment` requires `launchBindings` (see above), so a manifest written for `0.7.0-next.0` must add them. The bundled manifest and its embedded export have them.
- The terms-status read is shared: `readTermsStatus` in `client-terms.ts` serves the trading client's `getTermsStatus` and the launch client's `terms` step.
- `scripts/check-package.mjs` asserts the new value exports of `@oxley/sdk/launch` and `@oxley/sdk/abis`, the eight new ABI files and exports, a launch smoke test on the bundled manifest, and a typed
  consumer of the launch client; `creator-account` is no longer a forbidden file name in the archive.
- `docs/live-artifacts.json` replaces the earlier router/hook provenance (an uncommitted working tree at commit `3224cc13`) with the Gen10 compiled-graph provenance above.

### Tests

- 138 unit and ABI tests in 19 files pass (120 before): 16 new launch tests (pins and bindings by code hash, cost and duration-bound mismatches, each step's calldata against the compiled ABIs,
  the stage sequence, native value and gas, simulation failures and URL redaction, every pre-check, the block-rate sampler, the read-back, the manifest), one extra ABI/evidence test, and the launch reverts.
  Mutating the launch code (dropping the bond value, a pin check, the floor rules, the gas cap, the simulation caller or the failure handling, swapping arguments, the old 36,000 ceiling) fails these tests.
  `typecheck`, `build` and `test:package` pass; `test:live:abis` passes and `test:live:launch` passes against Elysium testnet (read-only). The local EVM suite (`npm run test:evm`) needs Anvil, which was not
  available on the build machine, and was not run.

### Not covered

- No launch transaction has been sent by this client: the approval and launch steps are simulated against a modelled launch graph, and live only through the read-only checks above (a real creator address
  prepared the `setup` step against the live factory). A funded end-to-end launch on testnet is the next check.
- Scheduled launches (`scheduleAuctionLaunch`), the unused-bond claim, creator fee claims, handover and metadata publication are not prepared; their ABI is `abis/creator-account.json`.
- That the compiler reproduces the artifacts from the sources on another machine is not proved here; the worktree's own forge build reproduced all twelve hashes, and the chain matches them.

## 0.7.0-next.0 - 2026-11-08

**Breaking.** The SDK now supports only Gen10, the contract release live on Elysium (testnet chain id 99801; mainnet will launch
with Gen10 only). Everything that existed only for the flat-fee release and for Gen2, Gen3, Gen8 and Gen9 is removed, and the
generation-prefixed names of what remains are plain names. Gen10 bids are Dynamic Bids through the accepted-bid router and the
per-wallet hook, so the generic bid path is gone with the rest. No contract is deployed and no transaction is broadcast by this change.

### Removed

- **Other generations.** The flat-fee, Gen2, Gen3, Gen8 and Gen9 manifests and their exports (`flatFeeTestnetDeployment`,
  `gen3TestnetDeployment`, `gen8TestnetDeployment`, `gen9TestnetDeployment`, `testnetDeployments`), the `GEN8_FAMILY` table with
  `GEN8_FAMILY_IDS`, `isGen8Family`, `gen8FamilyMember`, `Gen8FamilyId` and `Gen8FamilyMember`, `DeploymentGeneration`,
  `deploymentGeneration` and the manifest's `generation` field, the Gen3 manifest block (`gen3`, pro-trade router, order executor, reward
  authorizer, coin factory), and the Gen9 and Gen10 manifest slots in the release scripts.
- **Routing.** `createOxleyMarkets` (and `OxleyMarkets`, `DeploymentIdentityHint`, `MarketGeneration`, `MarketsDiscoveryOptions`, `resolveMarket`,
  `generations`, `client(name)`, `verifyDeployments`) are removed: one client is bound to one deployment, and `createOxleyClient` covers every
  call. The error codes `UNKNOWN_DEPLOYMENT`, `AMBIGUOUS_MARKET` and `IDENTITY_MISMATCH` are gone with it, and `Market.generation` is removed.
- **Generic bid path.** `prepareBid`, `getBidAllowance`, `buildAuctionBid`, `AuctionBidInput`, `parseAuctionDeployment` and the Gen2 breadth-rule hook
  ABI (`breadthBidHookAbi`), and the codes `DYNAMIC_BID_REQUIRED`, `GEN8_REQUIRED`, `GEN2_REQUIRED`, `AUCTION_NOT_REGISTERED`.
- **Launch client.** `createOxleyLaunchClient`, `buildCreatorAccount`, `buildAuctionLaunch`, `prepareLaunch`, `getLaunch`, `AuctionLaunchInput`,
  `LaunchDeployment`, `LaunchRpcClient`, `validateAuctionLaunch`, the exact-duration helpers (`auctionDurationBounds`, `auctionDurationBlocks`,
  `sampleSecondsPerBlock`, `AUCTION_MIN_BLOCKS_PER_HOUR`, `AUCTION_MAX_BLOCKS_PER_HOUR`, `BLOCK_RATE_SAMPLE_BLOCKS`), `launchBindings` in the manifest, the
  creator-account and factory ABIs (`creatorAccountAbi`, `creatorAccountFactoryAbi`, `gen2CreatorAccountAbi`, `launchControllerAbi`, `launchEntryAbi`,
  `launchBondAbi`) and all `LAUNCH_*`, `DURATION_*` and `EXACT_DURATION_*` codes. The client only ever served flat-fee and Gen2 deployments: it already
  refused Gen8, Gen9 and Gen10 (`UNSUPPORTED_GENERATION`), whose manifests carry no launch bindings. `@oxley/sdk/launch` keeps the pure launch-floor rules.
- **Trading shapes.** The account-taking `quoteBuy` and `quoteSell`, the five-argument `sell`, the collateral leg of a sell and its
  `COLLATERAL_OUTPUT` code, and the reserve-asset `market` layout. Revert decoding drops `AuctionNotRegistered`, `ExactDurationRequired`,
  `InvalidDurationBlocks` and `InvalidRequestedHours`, `walletCapMessage` and the `generation` option of `decodeOxleyRevert`.
- **Full compiler ABIs.** `@oxley/sdk/abis/{creator-account,creator-account-factory,auction-controller,auction-bid-router,auction-adapter,registry}.json` and
  `@oxley/sdk/abis/{gen2,gen3,gen8}/*` (flat-fee and earlier-generation ABIs). The controller, adapter and registry compiler ABIs for Gen10 are not in this
  repository, so those three are typed subsets only. Deployment exports `elysium-testnet-gen{2,3,8,9,10}.json` are replaced by `elysium-testnet.json`.
- **Docs, scripts and tests.** `docs/gen2-artifacts.json`, `docs/launch-artifacts.json`, `docs/launch-validation.md`, `docs/funded-swaps-2026-10-16.md`;
  `scripts/import-launch-fixtures.mjs`, `import-zero-ex-fixture.mjs`, `build-executor-fixture.mjs` and the `build:test-executor` script; `solc` from
  the dev dependencies; the Gen2, Gen3, Gen8 and Gen9 unit suites, and the local EVM launch and settlement suites with their flat-fee fixtures, the vendored
  0x BASIC test contracts and the BASIC test executor. The EVM settlement suite ran the SDK against real flat-fee curve bytecode and 0x BASIC; Gen10 creation
  bytecode is not in this repository, so it cannot be rebuilt here (see "Not covered").

### Renamed

| Before | After |
| --- | --- |
| `gen8CurveAbi` (and the flat-fee `curveAbi`) | `curveAbi` |
| `gen8BidRouterAbi` | `auctionBidRouterAbi` |
| `gen8BidHookAbi` | `bidHookAbi` |
| `gen8AdapterAbi` (`MAX_CCA_BID_PRICE_Q96`) | folded into `auctionAdapterAbi` |
| `gen2CurveAbi` | `tradingGateAbi` |
| `GEN8_MIN_BID`, `GEN8_TOKEN_CAP` | `MIN_BID`, `TOKEN_CAP` |
| `GEN8_MAX_LIVE_BIDS`, `GEN8_MAX_WALLET_BIDS`, `GEN8_MAX_PRICE_LEVELS` | `MAX_LIVE_BIDS`, `MAX_WALLET_BIDS`, `MAX_PRICE_LEVELS` |
| `GEN8_BID_RULES` | `BID_RULES` |
| `Gen8Position`, `Gen8Refusal`, `Gen8WalletLimits` | `BidPosition`, `BidRefusal`, `WalletLimits` |
| `GEN9_MAX_FLOOR_PRICE_WAD` | `MAX_FLOOR_PRICE_WAD` |
| `GEN8_MINIMUM_NET_RAISE`, `GEN10_MINIMUM_NET_RAISE` | `MINIMUM_NET_RAISE` (30,000e6) |
| `gen8MinimumNetRaise(generation)`, `gen8MinimumGrossRaise(generation)` | `MINIMUM_NET_RAISE`, `MINIMUM_GROSS_RAISE` (30,303,030,303) |
| `GEN8_OFFERED_UNITS` | `OFFERED_UNITS` |
| `floorReachesMinimumRaise(generation, floor)`, `validateLaunchFloor(generation, floor)` | `floorReachesMinimumRaise(floor)`, `validateLaunchFloor(floor)` |
| `minimumRaiseFloor(generation)` | `minimumRaiseFloor()` |
| `gen10TestnetDeployment` | `testnetDeployment` |
| `parseAuctionDeployment`, `parseLaunchDeployment` | `parseDeployment` (one validated shape for every client) |
| `openingFeeCurveAbi` | `openingFeeCurveAbi` without `termsRegistry` and the curve error entries (both are on `curveAbi`) |
| `@oxley/sdk/abis/gen8/curve.json`, `.../gen8/bid-router.json`, `.../gen8/bid-hook.json` | `@oxley/sdk/abis/curve.json`, `bid-router.json`, `bid-hook.json` |
| `@oxley/sdk/abis/terms-registry.json`, `.../cca-auction.json` | unchanged paths; files are now `abis/terms-registry.json`, `abis/cca-auction.json` |
| `@oxley/sdk/deployments/elysium-testnet-gen10.json` | `@oxley/sdk/deployments/elysium-testnet.json` (the Gen10 manifest, without the `generation` field) |
| `src/gen8-*.ts`, `src/auction-gen8-*.ts`, `src/gen9-abis.ts`, `src/curve-profile.ts` | `bid-rules.ts`, `bid-transactions.ts`, `witnesses.ts`, `auction-bid.ts`, `auction-graph.ts`, `auction-wallet.ts`, `curve.ts`, `controller-rules.ts` |

### Changed behaviour

- **One manifest shape.** `parseDeployment` validates the whole Gen10 manifest: curve, registry, USDC, controller, terms registry, router, adapter, bid hook
  and exposure helper (nine distinct addresses, each with its runtime code hash) and the exact `bidRules`. Both clients take the same manifest. The
  `generation` field is gone, and `TermsStatus.termsRegistry` is always an address. `deployments/mainnet.template.json` has the same fields as the testnet
  manifest, with placeholders. `getTradingStatus` returns `{ marketId, open, fallbackAt, ...block }` (the gate always applies; `gated` is removed).
  `Quote.openingSurchargeWad` is present on buys. The failing-verification messages no longer name a generation: "The controller's minimum raise differs
  from the 30,000 USDC this SDK mirrors".
- **Fix: market discovery.** `discoverMarkets` filtered the curve's logs with the earlier curve's event signature (`MarketActivated` with a `reserveAsset` field).
  The Gen10 curve's event is `MarketActivated(dealId, coin, creator, quoteSeed)`, so the filter's topic never matched a Gen10 activation. The filter now uses the
  compiled curve's event (`curveAbi`), and a test compares its selector with the compiled ABI's. The offline fixtures could not catch this: their logs were canned.
- **Kept checks.** Every Gen10 check remains with its test: pinned runtime code hashes, exact bid rules, distinct addresses, the controller's floor cap and
  minimum raise (a $50,000 controller cannot pass), the terms registry binding, simulation before a transaction is returned, wallet cap, bid-slot and
  creator refusals, terms acceptance, claim and refund preconditions, canonical-block checks and the data-feed validation. Two checks that could no longer fail
  are removed: the "is this a Gen8-family deployment" gates and the sell-collateral rejection.

### Tests, scripts and docs

- Unit suites are rebuilt on one synthetic Gen10 deployment (`test/support`); `test/deployment.test.ts` covers the record, importer, manifest, mainnet template,
  verification and embed script, `test/revert.test.ts` the revert decoder, and `test/artifacts.test.ts` checks every typed ABI subset against the hash-pinned compiler
  ABIs. Counts: 120 unit and ABI tests in 18 files pass, with typecheck, build and the clean-archive consumer check (`npm run test:package`); the local EVM suite was not run (no Anvil on the build machine).
- `scripts/check-package.mjs` asserts the exact value-export list of every entry point and that the archive contains nothing of another contract release.
  `import-live-manifests.mjs` imports the one live record and the four compiler ABIs; `embed-deployments.mjs` generates `src/testnet-deployment.ts`.
- `test:live:auctions`, `test:live:launch` and `test:live:markets` check the Gen10 graph, the floor rules against the live adapter, and (with `OXLEY_MARKET_ID`) a live
  market. They are read-only and were not run for this change.
- README and `docs/` describe Gen10 only. `docs/IOxleyCurve.sol` is the four-argument, account-free interface.

### Not covered

- The local EVM suite (`npm run test:evm`) keeps one scenario: SDK approvals, exits and claims against a real vendor CCA, with the retained bid router and adapter as
  bid-placing scaffolding. It needs Anvil and was not run here. Real-bytecode coverage of the Gen10 curve and router, and of 0x BASIC against the Gen10 curve, needs
  Gen10 creation bytecode fixtures.
- Typed subsets of the controller, adapter and registry have no Gen10 compiler ABI to be checked against in this repository (the adapter subset is checked against
  the retained adapter fixture).

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
