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
| Launch client: pin and binding verification, floor rules, each step's calldata, native value, simulation failures, read-back | `launch.test.ts` (details in [launch](launch.md)) |
| ABIs and artifacts: typed subsets match the compiled ABIs, ABI and fixture hashes, ABI-to-record evidence, package exports | `artifacts.test.ts`, `abi.test.ts` |
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
| `npm run test:live:launch` | Auction client `verifyDeployment`, then compares `quoteAuctionFloor` with the live adapter's `effectiveFloor` for six floors and checks `validateLaunchFloor` at the lowest accepted floor and one unit below; launch client `verifyDeployment` (launch pins, bindings, 1.5 USDC fee, 0.5 HYPE bond, duration bounds), the controller's `LAUNCH_NAMESPACE` and `dealIdFor` against `launchDealId`, and a launch and a scheduled launch prepared for an unfunded wallet, which must be refused with `INSUFFICIENT_QUOTE` after every chain read succeeded (the schedule's ticker hold and cooldown included); then, for the newest creator accounts the factory created, read by address: the account's scheduling constants (0.5 HYPE bond, 15 minute and 8 day leads, 24 hour window, 80 byte names, 10,000,000 dry-run gas) and the controller's 3 day ticker cooldown equal the SDK's, the bond escrow repays 12,000,000 gas at 1 gwei, the account's `eip712Domain()` is the publication domain, and `getScheduledLaunch`, `getBondRefund` and `getCreatorFees` run | `OXLEY_LAUNCH_OWNER` and `OXLEY_LAUNCH_SALT` read back an existing launch |
| `npm run test:live:metadata` | The token details service read as the SDK reads it, for three live deals: the publisher's controller and handover epoch equal the creator account's on chain, `resolveToken` agrees with the index, the service's clock is the wall clock, and the typed data the SDK would have the controller sign carries the account's domain. Nothing is signed or published | `OXLEY_APP_URL`, `OXLEY_RPC_URL` |
| `npm run test:live:abis` | For every contract in `live-artifacts.json`: the chain's runtime code with the compiler's immutable slots zeroed hashes to the published build's runtime template, and its hash is the manifest's pin; the creator account is checked on an account the factory created | none beyond `OXLEY_RPC_URL` |
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
  from (source path and sha256), the compiler job that built the deployed contracts (`compiledGraphSha256`, compiler
  settings, source commit), and for each of the twelve Oxley contracts the SDK touches its ABI file and Solidity
  source sha256, the build's creation-code and runtime-template keccak256, the immutable slots and the deployed pin.
  How the ABIs are tied to the deployed code is below. `artifacts.test.ts` checks the ABI file hashes and the evidence
  against the manifest and the record, and `deployment.test.ts` checks the record hash and that the manifest is its exact mapping.

### Which Build The ABIs Come From

The deployment record names `compiledGraphSha256` (`2b7ad321...`): the identity of the compiler job whose output was deployed
(solc 0.8.26, Cancun, optimizer 200 runs, no metadata hash). `scripts/import-live-manifests.mjs` refuses to write an ABI unless:

1. the compiled-graph file hashes to its own identity, with the deploy tooling's canonical-JSON rule, and that identity is the record's;
2. every one of the graph's 109 sources is byte-identical in the worktree the artifacts were read from;
3. the forge artifact's creation code and runtime template hash to the graph's `creationCodeKeccak256` and `runtimeTemplateKeccak256`,
   and its ABI and immutable slots equal the graph's;
4. a contract with no immutable slots (the exposure helper, the entry controller) has a runtime template equal to its pinned runtime code hash,
   which proves the artifact against the record with no chain read.

`npm run test:live:abis` then compares chain code with the same templates: with the immutable slots zeroed, the code at every pinned address
hashes to the template, and unmasked it hashes to the pin; a creator account created by the factory hashes to the creator account template.
Nothing is recompiled in this repository. Not proved: that the compiler would reproduce the artifacts from the sources on another machine
(the worktree's own forge build reproduced all twelve creation-code and runtime-template hashes), and anything about the immutable values themselves, which are the constructor
arguments the verification reads back through the clients.
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
- The compiler ABIs are the deployed Gen10 build's, but the quote token's is not: Oxy-USDC is an external contract, so `tokenAbi` is an
  ERC-20 subset with no compiled counterpart here.
- The launch client is tested against a modelled launch graph and read-only against the live chain; no launch transaction has been sent by
  it, so the later steps (approval, launch, schedule, execution, refund, claims) are simulated only offline. `test:live:launch` stops at an unfunded wallet.
- Token details and images were never published by these checks: a publication is an authenticated write to the live service and needs the creator account controller's key. The typed data is
  proved against the account's on-chain domain and against the digest computed from first principles, not by a signature the service accepted.
- Auction transactions are executed locally only through retained scaffolding, not the deployed Gen10 router,
  hook or adapter. Dynamic Bid and rebid preparation is tested against a modelled hook and auction.
