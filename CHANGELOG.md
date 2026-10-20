# Changelog

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
