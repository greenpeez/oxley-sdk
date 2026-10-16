# Auction Transactions

Available since `@oxley/sdk@0.5.0-next.2` via `@oxley/sdk/auctions`; current
`0.5.0-next.3` changes documentation only. ESM, Node 20+,
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

The included profile is the VNext flat-fee release on testnet `99801`, not every
historical auction. Some indexed display feeds contain older releases. Never pass
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
  auction has ended and failed graduation. The accepted-bid fee is **not refunded**.
- Successful fully filled bid: `exitBid` finalizes the allocation and returns
  unspent principal. This can be zero; it does not refund all spent funds.
- Successful partially filled/outbid bid: pass
  `partialFill: { lastFullyFilledCheckpointBlock, outbidBlock }` to encode
  `exitPartiallyFilledBid`. A normal exit may revert for these bids. Hints must come
  from the auction's checkpoint chain and are validated by simulation.

Hints are bigint uint64 **CCA virtual checkpoint numbers**, not event receipt block
numbers or timestamps. `outbidBlock: 0n` is the final-clearing-price-equality case,
not a default hint. An outbid early exit is only available when the contract's
graduation and checkpoint rules permit it. There is no arbitrary cancellation.
The SDK deliberately does not fabricate a refund amount or auto-submit retries.

## Claim Tokens

After the exit receipt succeeds, call `prepareClaim({ dealId, bidId, caller })`.
It refuses bids not yet exited or with no remaining allocation, then simulates
`claimTokens`. The contract enforces successful graduation and the claim block.
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
No native-asset bid or refund route, contract deployment, creator-bond withdrawal,
launch helper, generic recipient override or signing key is added here.

## Mainnet

Use a reviewed manifest with real USDC plus controller/router/adapter runtime pins.
`mainnet.template.json` is deliberately non-executable. The ABI and helpers are
reusable for the same reviewed contract interfaces; final addresses, bytecode,
bindings and on-chain behavior must be verified on the actual mainnet release.
