# Auction Validation

Evidence for `@oxley/sdk/auctions` at `0.7.0-next.0`: Dynamic Bids, rebids, wallet limits and the
recovery transactions (exit and claim) for the Gen10 release on Elysium testnet. No funded transaction is
part of it. Not an independent security audit.

## Offline Coverage

`test/dynamic-bids.test.ts`, `dynamic-bid-rules.test.ts`, `auctions.test.ts`, `launch-floor.test.ts`,
`floor-cap.test.ts` and `deployment.test.ts` run against an in-memory model of the controller, bid router,
adapter, bid hook, auction and a wallet (`test/support/auction.ts`). The model is not the deployed contracts.

- **Wallet limits.** Committed amount, ceiling and allowance come from the hook's `preview`, bounded by the
  balance after the 0.1% accepted-bid fee charged on top. Stored bids are classified as live, outbid or
  exited, slots are counted, and one witness is produced per stored bid. A stale or inconsistent checkpoint
  history, or more than 12 stored bids, gives `WITNESS_UNAVAILABLE` instead of a guess.
- **Dynamic Bids.** A first bid carries empty witnesses, a derived previous tick, exact approvals (a reset to
  zero first when a smaller nonzero allowance exists) and the quoted fee. Simulation needs the approval first
  (`APPROVAL_REQUIRED`). Anything the router, hook or auction would refuse is refused before simulation with a
  structured code: `BID_TOO_LOW`, `INVALID_AMOUNT`, `EXPIRED_DEADLINE`, `INVALID_BID_PRICE`,
  `WALLET_CAP_EXCEEDED` (with the largest allowed bid), `TERMS_NOT_ACCEPTED`, `CREATOR_BID_NOT_ALLOWED`,
  `AUCTION_NOT_OPEN`, `INVALID_BID_QUOTE` and `WALLET_BID_LIMIT`.
- **Rebids.** A rebid exits exactly one outbid, unexited bid of the wallet with that bid's own witness and
  bids again, and only once the auction has met its minimum raise. Otherwise `REBID_NOT_AVAILABLE`.
- **Rules and encoding.** Fee rounding, the affordable principal at every balance, the ceiling and allowance
  formulas, slot and lifetime counts, refusal order and tick alignment follow the hook's formulas. Witness
  data is exactly `abi.encode(BidWitness[])` with at most 12 `uint64` pairs. Bid and rebid calldata decode
  against the compiled router ABI.
- **Recovery.** Exit, partial-fill exit and claim selectors and arguments match the compiled auction ABI;
  integer widths and hints fail closed. A third party's transaction preserves the original owner, a claim
  needs the exit first, failed simulations propagate, and input is validated before any read.
- **Deployment binding.** An auction of another profile, controller, reserve asset or deal, a wrong chain,
  changed runtime code or a reorganized observation produces no transaction. Verification reads the
  controller's floor cap and its 30,000 USDC minimum raise and fails closed on any other value or on a
  changed hook, exposure helper or terms registry.
- **Launch floor rules.** The lowest accepted floor, the controller's `1e21` cap and the refusal messages
  (USDC only) are checked in `launch-floor.test.ts` and `floor-cap.test.ts`.

## Local EVM Suite

`ANVIL_BIN=anvil npm run test:evm` runs `test/integration/auctions.test.ts` on a local Anvil chain
(`31337`, Osaka). It deploys the vendor continuous clearing auction factory and creates real auctions from
the vendor bytecode, with the Permit2 runtime (checked by hash) and a controllable block clock. Retained
scaffolding (a bid router, adapter, fee router and test tokens; the first two and the vendor auction are
pinned in [auction-artifacts.json](auction-artifacts.json), the rest in `test/fixtures/provenance.json`)
creates the auctions and places the bids. Bidding is not the SDK path under test: the scaffolding's
`submitBid` has no witness argument, and the Gen10 bid router, hook and adapter are not deployed here.

What it executes are the SDK's own transactions, `buildAuctionBidApprovals`, `buildAuctionRefund` and
`buildAuctionClaim`, in four scenarios:

1. An accepted bid keeps its owner and debits the principal plus 0.1% on top; an exit before the auction
   ends reverts and changes no balance.
2. A failed auction: a third party's exit returns the principal to the bidder, not the executor; the fee is
   retained; replaying the exit, or claiming, reverts.
3. A successful auction: a claim before the exit reverts; after a third party's exit, the claim pays the
   original owner and nothing to the executor, and repeating it pays nothing more.
4. A partial fill: invalid checkpoint hints revert with no balance change; valid hints, read from the
   auction's checkpoints, return the remaining principal, and the claim then delivers tokens.

## Live Read-Only Checks

`npm run test:live:auctions` verifies the deployed Gen10 graph and asserts the router's `quoteBid` for 100
USDC; `OXLEY_AUCTION_ID` and `OXLEY_BIDDER` add an auction read and a wallet's limits. `npm run
test:live:launch` compares the SDK's floor rules with the live adapter and controller and verifies the launch graph. Both read testnet
only, with no signer. This page records no result of a live run; see [validation](validation.md) for what
each script does.

## Limits

- No funded bid, rebid, exit or claim has been sent by these SDK paths.
- `buildDynamicBid`, `buildDynamicRebid` and the Gen10 hook are not executed on an EVM in this repository.
  Their calldata is checked against the compiled router ABI, and their preparation against the model above.
- Fee-on-top accounting in the EVM suite is the scaffolding's, not the deployed router's.
- The `quoteBid` check at the live router reads the quote; it does not place a bid.
- Mainnet needs its own reviewed manifest and verification: see [mainnet inputs](mainnet.md).

## Reproduce

```sh
npm run typecheck
npm test
ANVIL_BIN=anvil npm run test:evm
npm run test:package
npm run test:live:auctions
npm run test:live:launch
```

No credentials or funded wallet are needed. Override `OXLEY_RPC_URL` for the live checks.
`scripts/import-auction-fixtures.mjs` documents how the frozen fixtures are produced and checked.
