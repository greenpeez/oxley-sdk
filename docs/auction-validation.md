# Auction SDK Validation

Release: `0.5.0-next.2`. Validation date: 2026-10-16.

## Automated Coverage

- Type checks cover public APIs, tests and the auction integration example.
- Unit tests compare typed ABI selectors, tuples and events with the complete
  compiler ABIs, and verify the retained artifact hashes. They exercise calldata,
  integer bounds, exact fee-inclusive approvals, deployment checks, reorg rejection,
  simulation failures, ownership, timing and recovery guards.
- Local EVM tests execute the real fee router, bid router, adapter and upstream
  CCA factory/auction bytecode with the real Permit2 runtime. Test tokens, a minimal
  fee-market fixture and a controllable ArbSys block clock isolate the scenarios.
  No production contract logic is replaced with a JavaScript mock in this suite.
- Execution covers an accepted bid with its fee charged on top, premature recovery
  rejection, failed-auction principal refunds with fees retained, successful exits
  and token claims, partial-fill refunds/claims, invalid checkpoint rejection,
  original-owner payouts from third-party execution and replay protection.
- Existing swap/BASIC atomicity tests remain in the same EVM test run.
- A separate clean consumer installs the actual npm archive, imports the public
  modules and all four auction ABI JSON exports, and compiles their TypeScript
  declarations. Package checks exclude tests, bytecode fixtures and private files.

## Read-Only Testnet Evidence

At Elysium testnet chain `99801`, block `10026269`, hash
`0xcfe553599ed782a7e87aef4a450eb908034e254edf06a4d6d8bdd7f30f414ba0`:

- Pinned controller, bid router, adapter, registry and quote-token runtimes matched.
- Contract-to-contract bindings, the quote currency and six-decimal precision matched.
- Deal `0x71d75a89abd94f6e48e76b94da911ee67ac8a976525dd73908c0cd37661b2093`
  resolved to auction `0xe44596B1E801fA660cc24eF7c6211Bf553479f3E`, with
  `open: false` and status `4` (refunding).
- `quoteBid(100000000)` returned principal `100000000`, total debit `100100000`
  and accepted-bid fee `100000`, all in six-decimal Oxy-USDC base units.

This check verifies deployed reads, not a new funded bid or a successful mainnet
launch. All transaction execution for this release was on an isolated local EVM.
These tests are not an independent security audit. Mainnet remains gated on a
reviewed real-USDC deployment manifest and verification of that deployment.

## Reproduce

```sh
npm run typecheck
npm test
npm run build
ANVIL_BIN=anvil npm run test:evm
npm run test:package
npm run test:live:auctions
```

The last command only reads testnet and paces requests for the public RPC.
Override `OXLEY_RPC_URL` or `OXLEY_AUCTION_ID` when needed. See
[artifact provenance](auction-artifacts.json) and
`scripts/import-auction-fixtures.mjs` for the frozen release inputs and integrity
checks. No credentials or funded wallet are needed for the automated tests.
