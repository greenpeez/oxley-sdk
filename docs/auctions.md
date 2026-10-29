# Auction Transactions

Available since `@oxley/sdk@0.5.0-next.2` via `@oxley/sdk/auctions`; `0.5.0-next.4`
added the separate [auction launch module](launch.md), `0.6.0-next.0` adds
[Gen2 bid rules](#gen2-breadth-rule-and-creator-exclusion) and `0.6.0-next.1` adds
[Gen8 Dynamic Bids](#gen8-dynamic-bids). ESM, Node 20+,
TypeScript and browser-compatible. No Oxley backend, API key or signer is required;
supply a viem public client with sufficient RPC capacity. The module only reads
chain state, simulates calls and returns unsigned transactions.

## Contracts And Exports

| Role | Typed ABI | Full compiler JSON export |
| --- | --- | --- |
| Launch controller | `auctionControllerAbi` | `@oxley/sdk/abis/auction-controller.json` |
| Fee-aware bid entry | `auctionBidRouterAbi` | `@oxley/sdk/abis/auction-bid-router.json` |
| Auction resolver | `auctionAdapterAbi` | `@oxley/sdk/abis/auction-adapter.json` |
| Per-auction CCA | `ccaAuctionAbi` | `@oxley/sdk/abis/cca-auction.json` |

Typed ABIs are integration subsets available from `/auctions` and `/abis`;
JSON exports contain the complete compiler ABI, including events and errors.
The controller creates/settles auctions; it does **not** expose bid, claim or
refund entrypoints. Bids must use the router to preserve the accepted-bid fee.
Do not call the raw CCA `submitBid` overloads: the validation hook rejects bypasses.

## Connect

```ts
import { createPublicClient, http } from 'viem';
import { createOxleyAuctionClient } from '@oxley/sdk/auctions';
import deployment from '@oxley/sdk/deployments/elysium-testnet.json'
  with { type: 'json' };

const auctions = createOxleyAuctionClient({
  deployment,
  publicClient: createPublicClient({
    transport: http('https://testnet-rpc.elysium.kinetiq.xyz'),
  }),
});
await auctions.verifyDeployment();
```

Each preparation verifies the chain, pinned controller/router/adapter/registry/
quote-token code, mutual bindings, registry campaign and resolved auction's token,
currency and hook at one block. A final hash check rejects reorganized observations.
The public RPC is rate-limited; use your normal production RPC transport, batching
or request pacing. `scripts/check-auctions-testnet.ts` demonstrates paced verification.

The default profile is the VNext flat-fee release on testnet `99801`; Gen8 bids use
`deployments/elysium-testnet-gen8.json`. Neither covers every historical auction. Some indexed display feeds contain older releases. Never pass
an indexed auction address directly to a signing flow; resolve its deal ID with
the correct reviewed manifest. Unsupported releases are rejected, not silently adapted.

## Bid

Call `prepareBid({ dealId, caller, entered, maxPriceQ96, previousTick, deadline })`.
The result includes `transaction`, `principal`, `fee`, `debit`, `approvals`,
`balance`, `allowance`, `sufficientBalance`, `owner` and the observation block/hash.

- `entered`: bigint uint128, six-decimal USDC/Oxy-USDC base units. The router's
  on-chain `quoteBid` determines principal, fee and total debit; no local fee assumption.
  Current testnet charges 0.1% on top: 100 Oxy-USDC principal requires 100.10 total.
- `maxPriceQ96`: CCA's raw Q96 quote-base-units per token-base-unit price, not a
  human dollar price or a WAD value. It must be on the auction's tick grid.
- `previousTick`: an explicit current tick-insertion hint. The SDK does not scan
  unbounded ticks, invent one, or change the bidder's maximum price.
- `deadline`: bigint Unix seconds. It protects bid submission, not final allocation.
- `caller`: the account that will actually send the transaction and pay the debit.
  It becomes the bid owner. There is no independent payer/beneficiary parameter.

Submit `approvals` in order and confirm successful receipts. They approve the bid
router for the exact total debit, resetting an insufficient nonzero allowance first.
Users do not approve Permit2 or the auction directly. Then prepare again with
`simulate: true` using fresh hints/deadline, confirm the returned quote/debit, and
send `transaction` from `caller` on its returned `chainId`. Simulation requires
real balance and allowance and propagates contract reverts. It is not a guarantee
against changes before inclusion. Persist the `AcceptedBidFee` event's auction,
owner and bid ID from a successful canonical receipt; never predict the next ID.

## Refund / Exit

`prepareRefund({ dealId, bidId, caller, partialFill? })` resolves the auction,
checks the bid has not exited, and simulates the unsigned exit transaction.

- Failed auction: `exitBid` returns the principal to its recorded owner once the
  auction has ended without meeting its minimum raise. The accepted-bid fee is **not refunded**.
- Successful fully filled bid: `exitBid` finalizes the allocation and returns
  unspent principal. This can be zero; it does not refund all spent funds.
- Successful partially filled/outbid bid: pass
  `partialFill: { lastFullyFilledCheckpointBlock, outbidBlock }` to encode
  `exitPartiallyFilledBid`. A normal exit may revert for these bids. Hints must come
  from the auction's checkpoint chain and are validated by simulation.

Hints are bigint uint64 **CCA virtual checkpoint numbers**, not event receipt block
numbers or timestamps. `outbidBlock: 0n` is the final-clearing-price-equality case,
not a default hint. An outbid early exit is only available when the contract's
success and checkpoint rules permit it. There is no arbitrary cancellation.
The SDK deliberately does not fabricate a refund amount or auto-submit retries.

## Claim Tokens

After the exit receipt succeeds, call `prepareClaim({ dealId, bidId, caller })`.
It refuses bids not yet exited or with no remaining allocation, then simulates
`claimTokens`. The contract enforces that the auction succeeded and the claim block.
Submit the returned transaction; tokens go to the recorded owner, never `caller`
merely because it paid gas. Third parties may trigger exits/claims without acquiring
the payout. Keeper-completed exits/claims are reflected by current reads; do not
blindly replay an old plan. Bid ID `0n` is valid.

The exit and claim are separate transactions unless a caller deliberately composes
them with its own executor. Auction participation is **not** an immediately
settling swap or a 0x BASIC swap leg. A shared executor submitting bids owns those
bids and must implement its own custody/accounting; the SDK cannot infer end users.

## Low-Level Builders

`buildAuctionBid`, `buildAuctionClaim`, `buildAuctionRefund`, and
`buildAuctionBidApprovals` encode transactions without RPC reads. They validate
addresses, integer widths and identities, but do **not** establish deployment trust,
auction readiness, ownership, balances, allowances or valid tick/checkpoint hints.
Use the verified client by default. All bid/claim/refund transactions have `value: 0n`.
No native-asset bid or refund route, creator-bond withdrawal, generic recipient
override or signing key is added here. Creator-account setup and auction launch
helpers are available separately from `@oxley/sdk/launch`.

## Gen2 Breadth Rule And Creator Exclusion

For manifests declaring `"generation": "gen2"` (currently planned fork-rehearsal
addresses only, `"status": "planned-fork-addresses"`), the validation hook bound to
the router and adapter (`ElysiumBreadthCcaBidHook`, full ABI at
`@oxley/sdk/abis/gen2/bid-hook.json`) adds two rules. Router, claim and refund ABIs
are unchanged.

- Each wallet's committed principal is capped at `walletCap` (10% of the auction's
  minimum gross raise, rounded up) until the capped commitments reach that minimum;
  after that there is no per-wallet limit. Committed principal never decreases, so an
  outbid wallet at the cap cannot bid again until the auction has broad support.
- The creator account and its initial controller cannot bid (`CreatorBidNotAllowed`).

`getBidAllowance({ dealId, owner })` returns `walletAllowance` (principal, bigint),
`unlimited` (allowance is `maxUint256`), `walletCap`, `minimumGrossRaise`, `counted`,
`breadthReached`, `committed`, `creatorExcluded`, `registered` and the `hook` with the
usual auction and block fields. It checks the hook is bound to the reviewed router.
On Gen2, `prepareBid` compares the router-quoted **principal** (the 0.1% fee is on
top) with that allowance and fails closed before any simulation with
`WALLET_CAP_EXCEEDED` (`details.walletAllowance`), `CREATOR_BID_NOT_ALLOWED` or
`AUCTION_NOT_REGISTERED`; successful results include `bidAllowance`.

The Gen2 router pre-checks bids, so wallets see `WalletCapExceeded(owner, requested,
remainingAllowance)`, `CreatorBidNotAllowed(owner)` or `AuctionNotRegistered(auction)`
directly. `decodeOxleyRevert(error)` decodes these (also inside the CCA's
`ValidationHookCallFailed`) into `{ name, args, message }`, for example
"You can bid up to 5050.505051 USDC more until this auction has broad support".

After a successful settlement, the Gen2 curve keeps trading closed until every bid
is delivered or 10 minutes after activation. Use the trading client's
`getTradingStatus(marketId)`; quotes and swaps fail closed with `TRADING_NOT_OPEN`.

## Gen8 Dynamic Bids

Gen8 is the current launch generation (`deployments/elysium-testnet-gen8.json`,
release `elysium-auctions-gen8-969bd0e317da4145`). Bids go through the same fee-aware router
idea, but the router now carries per-wallet **witnesses** and the hook enforces dynamic,
per-wallet limits instead of the Gen2 breadth rule. The manifest pins the router, adapter,
`bidHook`, `exposureHelper` and the terms registry, and carries the exact compiled `bidRules`
(any other value is refused, `INVALID_BID_RULES`). Full ABIs: `@oxley/sdk/abis/gen8/bid-router.json`
and `bid-hook.json`; typed subsets `gen8BidRouterAbi`, `gen8BidHookAbi`, `ccaCheckpointAbi`.

| Rule | Value | Enforced by |
| --- | --- | --- |
| Minimum bid | 20 Oxy-USDC principal | hook (`BidAmountTooLow`) |
| Wallet ceiling | `max(ceil(minimumGrossRaise / 10), otherWalletsCommitted / 9)` | hook `preview` (`WalletCapExceeded`) |
| Token cap | 30,000,000 tokens per wallet, applied at the clearing price | hook (`WalletCapExceeded`) |
| Live bids | 3 per wallet; an outbid bid frees its slot | hook (`WalletBidLimitReached`) |
| Bids per wallet | 12 in total, outbid and exited bids still count | hook (`WalletBidLimitReached`) |
| Price levels | 1,000 initialized levels above the clearing price | hook (`PriceLevelLimit`) |
| Accepted-bid fee | 0.1% of the entered principal, on top, rounded down | router (`quoteBid`) |
| Terms and creator exclusion | accepted terms required; the creator account and its launcher cannot bid | hook |

A wallet's commitment counts the unspent principal of its bids: an outbid bid keeps its funds
locked and counted until it is exited, but frees its live slot. The constants are exported
(`GEN8_MIN_BID`, `GEN8_TOKEN_CAP`, `GEN8_MAX_LIVE_BIDS`, ...) with pure helpers `acceptedBidFee`,
`bidDebit`, `affordableBid`, `walletCeiling`, `walletAllowance`, `bidsRemaining`, `maximumNewBid`,
`bidRefusal` and `alignBidPrice`. They mirror the hook for forms; the hook stays the authority.

```ts
import { createOxleyAuctionClient } from '@oxley/sdk/auctions';
import deployment from '@oxley/sdk/deployments/elysium-testnet-gen8.json' with { type: 'json' };

const auctions = createOxleyAuctionClient({ deployment, publicClient });
await auctions.verifyDeployment(); // adds hook, helper, terms registry and compiled-rule checks

const limits = await auctions.getDynamicBidLimits({ dealId, owner });
// committed, ceiling, allowance (hook preview), balance, maximumBid, liveBids, bidsLeft,
// positions[{ bidId, amountUnits, maxPriceQ96, exited, outbid }], clearingPriceQ96,
// minimumRaiseMet, creatorExcluded, termsAccepted, rules

const bid = await auctions.prepareDynamicBid({ dealId, caller: owner, entered: 100_000_000n, maxPriceQ96 });
// submit bid.approvals first; then prepare again with simulate: true and send bid.transaction
```

`prepareDynamicBid({ dealId, caller, entered, maxPriceQ96, previousTick?, deadline?, simulate? })`
reads everything at one block and fails closed before any simulation with a structured
`OxleyError`: `BID_TOO_LOW`, `INVALID_BID_PRICE` (off tick, not above the clearing price or above
the CCA ceiling), `AUCTION_NOT_OPEN`, `INVALID_BID_QUOTE`, `TERMS_NOT_ACCEPTED`,
`CREATOR_BID_NOT_ALLOWED`, `WALLET_BID_LIMIT`, `WALLET_CAP_EXCEEDED` (`details.maximumBid`).
It then:

- computes the **witnesses**: one per bid the wallet already has stored on the auction. A bid still
  above the clearing price names the latest stored checkpoint; an outbid bid names the exact
  checkpoints that bracket its price, read from the auction's `CheckpointUpdated` history and
  re-verified against stored checkpoints. They are encoded as `abi.encode(BidWitness[])` in the
  router's `data` argument; `WITNESS_UNAVAILABLE` means the history could not be proven.
- derives `previousTick` by walking the auction's initialized ticks (at most 1,000 steps) unless
  you supply it, and defaults `deadline` to two minutes from the later of the head block and the
  local clock, because a quiet Elysium head can be hours old;
- returns `approvals` (exact total debit to the router, zero-reset first), `principal`, `fee`,
  `debit`, `limits`, `witnesses`, `previousTick`, `deadline` and `transaction` (`submitBid`).

`prepareDynamicRebid({ ...same, oldBidId })` exits one of the wallet's outbid, unexited bids and
bids again in one transaction (`rebid`), using that bid's own witness as the exit hint. It is
available only once the auction has met its minimum raise (`minimumRaiseMet`, the CCA's
`isGraduated()` view), the new price must be above the clearing price, and every normal bid rule
and the 0.1% fee apply again (`REBID_NOT_AVAILABLE` otherwise). A rebid is not subject to the
local cap pre-check because the router exits the old bid first and the hook accounts for that.

`prepareBid` refuses Gen8 deployments (`DYNAMIC_BID_REQUIRED`) and `prepareDynamicBid` refuses the
others (`GEN8_REQUIRED`). `buildDynamicBid` and `buildDynamicRebid` encode without any RPC read, and
`encodeBidWitnesses` / `decodeBidWitnesses` convert the `data` argument. Claim and refund builders are
unchanged: they target the resolved CCA, and delivery on Gen8 is keeper-driven. Gen3 deployments
are rejected (`UNSUPPORTED_GENERATION`): no Gen3 auction accepts new bids. Gen8 launches use their
own creator account and are not prepared by `/launch`.

Gen8 currently has no active auction (its first, G8TEST, failed), so the live check
`npm run test:live:markets` verifies the Gen8 graph, its bindings and the hook's compiled rules, while bid
preparation itself is covered by the offline suite against a modelled hook and CCA.

## Mainnet

Use a reviewed manifest with real USDC plus controller/router/adapter runtime pins.
`mainnet.template.json` is deliberately non-executable. The ABI and helpers are
reusable for the same reviewed contract interfaces; final addresses, bytecode,
bindings and on-chain behavior must be verified on the actual mainnet release.
