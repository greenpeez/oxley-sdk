# Validation Evidence

Evidence for `@oxley/sdk` `0.7.0-next.0` and its one supported release, Gen10
(`elysium-auctions-gen10-1fa4ef2a98fd14ed`, Elysium testnet, chain `99801`). It covers this package, not
whole-repository acceptance or a contract security audit. No funded transaction is part of it, and no
result of a live run is recorded here: the scripts below print what they verified when you run them.

## Offline Suites

`npm run typecheck` checks the library, tests and examples. `npm test` runs `test/*.test.ts` against
in-memory RPC doubles; no network, signer or compiler is needed. Counts: see CHANGELOG 0.7.0-next.0.

| Area | Tests |
| --- | --- |
| Manifest and verification: the bundled manifest is the live deployment record mapped to the SDK shape and equals the embedded export; pins, bid rules, distinct addresses; placeholders and testnet-on-mainnet refused; controller floor cap and minimum raise; changed hook, helper or terms registry | `deployment.test.ts`, `sdk.test.ts`, `terms.test.ts` |
| Trading: quotes from the curve's views with its real fee, swap calldata against the compiled curve ABI, 0x BASIC offset 36, exact zero-first approvals, trading gate, discovery, reorg rejection, quote batches bounded to four reads in flight | `sdk.test.ts`, `markets.test.ts`, `client-lifecycle.test.ts`, `opening-fee.test.ts` |
| Integrator fees: ordered fee batches, rounding and caps, tamper and staleness checks, EIP-5792 request | `integrator-fee.test.ts` |
| Terms and revert decoding | `terms.test.ts`, `revert.test.ts`, `floor-cap.test.ts` |
| Auctions: Dynamic Bids, rebids, wallet limits, witnesses, claims and exits, launch floor rules | `auctions.test.ts`, `dynamic-bids.test.ts`, `dynamic-bid-rules.test.ts`, `launch-floor.test.ts` (details in [auction validation](auction-validation.md)) |
| ABIs and artifacts: typed subsets match the compiled ABIs, ABI and fixture hashes, package exports | `artifacts.test.ts`, `abi.test.ts` |
| Indexed data client: see [data validation](data-validation.md) | `data.test.ts`, `data-tip.test.ts`, `market-observations.test.ts` |

`npm run test:package` packs the actual archive, installs it into an unrelated project, imports every
entry point, compiles the declarations and checks the file allowlist.

## Live Read-Only Checks

These scripts read Elysium testnet only: no signer, no transaction. They use the public RPC
`https://testnet-rpc.elysium.kinetiq.xyz` unless `OXLEY_RPC_URL` is set, and the bundled manifest.

| Command | What it does | Optional env |
| --- | --- | --- |
| `npm run test:live` | Trading client `verifyDeployment`; with a market and caller, one buy quote for 1 USDC (Oxy-USDC) | `OXLEY_MARKET_ID` and `OXLEY_CALLER` (both) |
| `npm run test:live:auctions` | Auction client `verifyDeployment` (all pins, bindings, hook rules, floor cap, minimum raise); asserts the router's `quoteBid(100 USDC)` is principal 100,000,000, debit 100,100,000, fee 100,000 | `OXLEY_AUCTION_ID` (deal ID) reads the auction; with `OXLEY_BIDDER` also that wallet's limits |
| `npm run test:live:launch` | Auction client `verifyDeployment`, then compares `quoteAuctionFloor` with the live adapter's `effectiveFloor` for six floors and checks `validateLaunchFloor` at the lowest accepted floor and one unit below | none beyond `OXLEY_RPC_URL` |
| `npm run test:live:markets` | Opening-surcharge schedule against the curve's `surchargeWadAt` (0 to 70 s), trading and auction `verifyDeployment`; with a market, its status, quotes, fee-bearing buy and sell batches and terms status | `OXLEY_MARKET_ID` |

The market check uses placeholder holder and recipient addresses, so it needs no funded wallet and its fee
batches are prepared and checked, never sent. The auction and market checks pace their requests for the
public RPC. Run them against the live Gen10 release before relying on it.

## Local EVM Suite

`ANVIL_BIN=anvil npm run test:evm` needs Anvil from Foundry. It runs `test/integration/auctions.test.ts`
on a local chain (id `31337`): the vendor continuous clearing auction factory and auction bytecode, the
Permit2 runtime (hash-checked), a controllable block clock, and retained scaffolding that creates
auctions and places bids. Using the SDK's approval, exit and claim transactions it checks accepted bids
and fees on top, premature exit, failed-auction refunds, successful exits and claims, and partial-fill
exits. See [auction validation](auction-validation.md).

## Provenance

- [live-artifacts.json](live-artifacts.json): the live deployment record the bundled manifest is mapped
  from (source path and sha256), and the compiler ABIs of the curve, bid router, bid hook and terms
  registry (artifact, ABI file and Solidity source sha256). `artifacts.test.ts` checks the ABI file
  hashes and `deployment.test.ts` checks the record hash and that the manifest is its exact mapping.
- [auction-artifacts.json](auction-artifacts.json): the vendor continuous clearing auction (published ABI
  and fixture) and the retained scaffolding fixtures used by the EVM suite, each sha256-pinned.
  `test/fixtures/provenance.json` pins the retained fee router and test token the same way.

## Trading And Quote Checks

- Quotes come from the curve's own views at one pinned block, need no balance or allowance, and are
  independent of any off-chain price. A quote with no executable output is refused.
- A quote batch caches market validation within its block. For a warm single-market batch of 64 samples
  the SDK performs 64 quote reads, three shared market reads, one chain read and two block reads, with
  at most four samples in flight. No latency or throughput guarantee is asserted.
- Calldata, approvals and quotes imply no funded action. The SDK never signs or sends; `checkSwap` with
  `simulate` set runs only when the caller already holds the balance, approval and accepted terms.
- Indexed-data checks are in [data validation](data-validation.md).

## Limits

- No funded transaction has been sent by these SDK paths, and none is implied.
- Not mainnet-ready: [mainnet inputs](mainnet.md) lists what a reviewed mainnet manifest still needs.
- No 0x hosted-route acceptance. BASIC calldata is checked offline (amount at byte offset 36); no BASIC
  route is settled on an executor in this repository, and calldata compatibility is not source acceptance.
- No real-bytecode curve settlement test exists for this release: the Gen10 creation bytecode is not in
  this repository, so the earlier real-bytecode curve and 0x BASIC settlement test was removed.
- The registry and controller compiler ABIs are not shipped. Their typed subsets are therefore not
  cross-checked against compiled ABIs here; only the curve, bid router, bid hook, terms registry and
  vendor auction are, plus the adapter against its retained fixture.
- Auction transactions are executed locally only through retained scaffolding, not the deployed Gen10 router,
  hook or adapter. Dynamic Bid and rebid preparation is tested against a modelled hook and auction.
