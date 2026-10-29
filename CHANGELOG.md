# Changelog

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
