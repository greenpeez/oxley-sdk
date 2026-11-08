# Auctions

`@oxley/sdk/auctions` reads auction state from chain, simulates calls and returns
**unsigned** transactions for Dynamic Bids, rebids, exits (refunds) and token claims.
ESM, Node 20+, browser-compatible. No Oxley backend, API key or signer is involved: the
caller supplies a viem public client and signs and sends every transaction with its own
wallet. Amounts are USDC base units (six decimals; Oxy-USDC on testnet).

## Contracts And Exports

| Role | Typed ABI | Full compiler ABI JSON |
| --- | --- | --- |
| Launch controller | `auctionControllerAbi` | typed subset only |
| Accepted-bid router | `auctionBidRouterAbi` | `@oxley/sdk/abis/bid-router.json` |
| Per-wallet bid hook | `bidHookAbi` | `@oxley/sdk/abis/bid-hook.json` |
| Auction resolver (adapter) | `auctionAdapterAbi` | typed subset only |
| Per-auction CCA | `ccaAuctionAbi`, `ccaCheckpointAbi` | `@oxley/sdk/abis/cca-auction.json` |

Typed ABIs are integration subsets (from `/auctions` and `/abis`); the JSON files are the
complete compiler ABIs, including events and errors. The controller creates and settles
auctions but has no bid, claim or refund entrypoint. Bids go through the router, which
charges the accepted-bid fee; never call the raw CCA `submitBid` overloads, the bid hook
rejects bypasses.

## Connect

```ts
import { createPublicClient, http } from 'viem';
import { testnetDeployment } from '@oxley/sdk';
import { createOxleyAuctionClient } from '@oxley/sdk/auctions';

const auctions = createOxleyAuctionClient({
  deployment: testnetDeployment, // or: import json from '@oxley/sdk/deployments/elysium-testnet.json' with { type: 'json' }
  publicClient: createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') }),
});
await auctions.verifyDeployment(); // { deployment, blockNumber, blockHash, timestamp }
```

`parseDeployment` (called by the client) validates and freezes the manifest: curve,
registry, USDC, controller, terms registry, the router, adapter, bid hook and exposure
helper, all distinct, plus the exact `bidRules` record. `verifyDeployment()` then checks,
at one block:

- the runtime code hash of the router, adapter, registry, USDC, controller, bid hook,
  exposure helper and terms registry (`CODE_MISMATCH`);
- the controller, router, adapter and USDC bindings, and that the hook is bound to the
  pinned router, terms registry and exposure helper (`AUCTION_BINDING_MISMATCH`);
- the hook's compiled rules (`MIN_BID_AMOUNT`, `TOKEN_CAP`, `MAX_PRICE_LEVELS`);
- the controller's floor cap `MAX_FLOOR_PRICE_WAD()` = 1e21 and its net `minimumRaise()` =
  30,000 USDC with `minimumGrossRaise()` = 30,303,030,303;
- a final canonical-hash check (`REORG`).

Every preparation repeats this at its own block. The public RPC is rate-limited: use your
production transport, batching or request pacing (`scripts/check-auctions-testnet.ts`
shows paced verification). `getAuction(dealId)` resolves a deal ID to its CCA through the
controller, registry and adapter and returns `{ dealId, auction, coin, open, status }` plus
the observation block; a deal that does not belong to this deployment is
`UNSUPPORTED_AUCTION`. Never pass an indexed auction address to a signing flow; resolve the
deal ID with the reviewed manifest.

## Bid Rules

| Rule | Value | Enforced by |
| --- | --- | --- |
| Minimum bid | 20 USDC principal (`MIN_BID`) | hook (`BidAmountTooLow`) |
| Wallet ceiling | `max(ceil(minimumGrossRaise / 10), other wallets' commitments / 9)` | hook `preview` (`WalletCapExceeded`) |
| Token cap | 30,000,000 coins per wallet per auction (`TOKEN_CAP`); the remainder is valued at the clearing price | hook (`WalletCapExceeded`) |
| Live bids | 3 per wallet (`MAX_LIVE_BIDS`); an outbid bid frees its slot | hook (`WalletBidLimitReached`) |
| Bids per wallet | 12 in total (`MAX_WALLET_BIDS`); outbid and exited bids still count | hook (`WalletBidLimitReached`) |
| Price levels | at most 1,000 initialized levels (`MAX_PRICE_LEVELS`) | hook (`PriceLevelLimit`) |
| Accepted-bid fee | 0.1% of the principal, on top, rounded down (`ACCEPTED_BID_FEE_BPS` = 10) | router (`quoteBid`) |
| Terms, creator | the wallet must have accepted the current terms; the auction's creator and the controller cannot bid | hook |

The opening wallet ceiling is a tenth of the controller's gross minimum, **$3,030.303031**.
100 USDC of principal costs 100.10 USDC in total. These rules are exported as constants
(`MIN_BID`, `TOKEN_CAP`, `BID_RULES`, ...) with pure helpers that mirror the hook for forms
and pre-checks (the hook stays the authority): `acceptedBidFee`, `bidDebit`,
`affordableBid`, `walletCeiling`, `walletAllowance`, `liveBids`, `bidsRemaining`,
`maximumNewBid`, `bidRefusal` (returns `'creator' | 'terms' | 'bids' | 'minimum' | 'cap'`),
`alignBidPrice`, `witnessFor` and `normalizeCheckpoints`.

`getDynamicBidLimits({ dealId, owner })` reads a wallet's standing at one block and
returns: `clearingPriceQ96`, `minimumRaiseMet` (the CCA's minimum-raise flag),
`creatorExcluded`, `termsAccepted`, `minimumBid`, the hook's `committed`, `ceiling` and
`allowance`, the wallet's `balance`, `maximumBid` (the allowance bounded by what the
balance covers after the fee), `liveBids`, `bidsLeft`, `positions`
(`{ bidId, amountUnits, maxPriceQ96, exited, outbid }`) and `rules`.

## Bidding With A Wallet Or An Agent

Every `prepare*` call returns unsigned transactions; the caller's wallet signs and sends
them. An autonomous agent follows the same loop as an app: read limits, prepare, send the
approvals in order, prepare again with `simulate: true`, send.

```ts
import { createPublicClient, http, type Hex, type WalletClient } from 'viem';
import { testnetDeployment, type Transaction } from '@oxley/sdk';
import { bidRefusal, createOxleyAuctionClient } from '@oxley/sdk/auctions';

const publicClient = createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') });
const auctions = createOxleyAuctionClient({ publicClient, deployment: testnetDeployment });

async function send(wallet: WalletClient, tx: Transaction) {
  if (await wallet.getChainId() !== tx.chainId) throw new Error('wallet is on the wrong chain');
  const hash = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to: tx.to, data: tx.data, value: tx.value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
  return receipt;
}
// Approvals first (confirmed), then a fresh simulated preparation, then the transaction itself.
async function submit(wallet: WalletClient, prepare: (simulate: boolean) =>
  Promise<{ approvals: readonly Transaction[]; transaction: Transaction }>) {
  for (const approval of (await prepare(false)).approvals) await send(wallet, approval);
  return send(wallet, (await prepare(true)).transaction);
}

export async function bid(wallet: WalletClient, dealId: Hex, maxPriceQ96: bigint, entered: bigint) {
  const caller = wallet.account!.address;
  const limits = await auctions.getDynamicBidLimits({ dealId, owner: caller });
  const refusal = bidRefusal(limits, entered); // 'terms' means the owner must accept the terms first (see markets.md)
  if (refusal) throw new Error(`cannot bid: ${refusal}; at most ${limits.maximumBid} base units`);
  return submit(wallet, simulate => auctions.prepareDynamicBid({ dealId, caller, entered, maxPriceQ96, simulate }));
}

// An outbid bid can be exited and replaced in one transaction once the auction has met its minimum raise.
export async function rebid(wallet: WalletClient, dealId: Hex, oldBidId: bigint, maxPriceQ96: bigint, entered: bigint) {
  const caller = wallet.account!.address;
  return submit(wallet, simulate => auctions.prepareDynamicRebid({ dealId, caller, oldBidId, entered, maxPriceQ96, simulate }));
}

// After the auction ends: exit the bid (refund or finalize), confirm, then claim the coins.
export async function exitAndClaim(wallet: WalletClient, dealId: Hex, bidId: bigint) {
  const caller = wallet.account!.address;
  await send(wallet, (await auctions.prepareRefund({ dealId, bidId, caller })).transaction);
  return send(wallet, (await auctions.prepareClaim({ dealId, bidId, caller })).transaction);
}
```

Persist the `AcceptedBidFee` (and, for a rebid, `Rebid`) event's auction, owner and bid ID
from a successful receipt; never predict the next bid ID. A prepared transaction is
only as fresh as its block: prepare again after any delay.

### Choosing `maxPriceQ96`

The CCA price is raw Q96 quote base units per coin base unit, not a dollar or WAD value. For a
human USDC-per-coin price: `parseUnits('0.0002', 6) * 2n ** 96n / 10n ** 18n`. It must be
on the auction's tick grid, above the clearing price and at most the CCA ceiling.
`alignBidPrice(requestedQ96, { floorPriceQ96, tickSpacingQ96, maxPriceQ96, clearingPriceQ96 })`
rounds down to the grid and throws `INVALID_BID_PRICE` otherwise; read `floorPrice` and
`tickSpacing` from the auction (`ccaAuctionAbi`), `MAX_CCA_BID_PRICE_Q96` from the adapter
(`auctionAdapterAbi`) and `clearingPriceQ96` from the limits.

## Prepare A Bid

`prepareDynamicBid({ dealId, caller, entered, maxPriceQ96, previousTick?, deadline?, simulate? })`:

- `entered`: principal, at least 20 USDC and below 2^128. The router's `quoteBid` supplies
  the fee and total debit; an inconsistent quote is `INVALID_BID_QUOTE`.
- `caller`: the wallet that sends the transaction, pays the debit and **owns the bid**.
  There is no separate payer or beneficiary.
- `previousTick`: omit it and the SDK finds the insertion point by walking the auction's
  initialized ticks (at most 1,000 steps, else `TICK_UNAVAILABLE`).
- `deadline`: Unix seconds; defaults to two minutes from the later of the head block and
  the local clock, because a quiet Elysium head can be hours old. It protects submission
  only, not final allocation.
- `simulate: true` simulates the router call from `caller`. It needs the balance and the
  confirmed approvals first (`INSUFFICIENT_BALANCE`, `APPROVAL_REQUIRED`); contract
  reverts propagate, and `decodeOxleyRevert(error)` turns them into short messages.

Everything is read at one block and refused before simulation with an `OxleyError` when
the hook or CCA would refuse it: `AUCTION_NOT_OPEN`, `BID_TOO_LOW`, `INVALID_BID_PRICE`,
`TERMS_NOT_ACCEPTED`, `CREATOR_BID_NOT_ALLOWED`, `WALLET_BID_LIMIT`,
`WALLET_CAP_EXCEEDED` (`details.maximumBid`). It also computes the **witnesses**, one per
bid the wallet already has on the auction: a bid still above the clearing price names the
latest stored checkpoint, an outbid bid names the exact checkpoints that bracket its price,
read from the auction's `CheckpointUpdated` history and re-verified against stored
checkpoints (`WITNESS_UNAVAILABLE` if the history cannot be proven). The router receives
them as `data = abi.encode(BidWitness[])` in `submitBid(id, maxPrice, entered,
previousTick, deadline, data)`.

The result carries `transaction`, `principal`, `fee`, `debit`, `approvals`, `balance`,
`allowance`, `sufficientBalance`, `owner`, `simulated`, `deadline`, `previousTick`,
`limits`, `witnesses` and the observation block. `approvals` are exact: the router is
approved for the total debit, with a zero-approval first when a smaller nonzero allowance
exists. No Permit2 or direct auction approval is involved.

## Rebid

`prepareDynamicRebid({ ...same, oldBidId })` exits one of the wallet's outbid, unexited
bids and bids again in one transaction (`rebid`), using that bid's own witness as the exit
hint. It is available only once the auction has met its minimum raise (`minimumRaiseMet`)
and only for a bid that is outbid and unexited (`REBID_NOT_AVAILABLE` otherwise). The new
price must be above the clearing price, and every normal bid rule and the 0.1% fee apply
again; the local cap check is skipped because the router exits the old bid first and the
hook accounts for that.

## Exit (Refund) And Claim

`prepareRefund({ dealId, bidId, caller, partialFill? })` checks the bid has not exited
(`ALREADY_EXITED`) and simulates the exit from `caller`.

- Failed auction: `exitBid` returns the principal to the bid's recorded owner. The
  accepted-bid fee is **not refunded**.
- Successful, fully filled bid: `exitBid` finalizes the allocation and returns unspent
  principal (possibly zero).
- Successful, partially filled or outbid bid: pass `partialFill: { lastFullyFilledCheckpointBlock,
  outbidBlock }` to encode `exitPartiallyFilledBid`. These are bigint uint64 **CCA
  checkpoint numbers**, not receipt block numbers or timestamps; `outbidBlock: 0n` is only
  the final-clearing-price-equality case. Validation is by simulation.

`prepareClaim({ dealId, bidId, caller })` refuses a bid that has not exited or has no
allocation (`NOT_CLAIMABLE`), then simulates `claimTokens`. Exit and claim are separate
transactions. Coins and refunds always go to the recorded bid owner, never to a third party
that merely paid gas or triggered the call; keeper-completed exits and claims show up in
fresh reads, so do not replay an old plan. Bid ID `0n` is valid. Both results carry
`transaction`, `bidId`, `owner` and `simulated: true`.

An auction bid is not an immediately settling swap and not a 0x BASIC leg. A shared
executor that submits bids owns them and must run its own custody and accounting.

## Low-Level Builders

`buildDynamicBid`, `buildDynamicRebid`, `buildAuctionClaim`, `buildAuctionRefund`,
`buildAuctionBidApprovals`, `encodeBidWitnesses` and `decodeBidWitnesses` encode without any
RPC read. They validate addresses, integer widths and hint shapes, but not deployment
trust, auction readiness, ownership, balances, allowances or the hints themselves; use the
client by default. Every auction transaction has `value: 0n`.

## Errors

`OxleyError.code` values from this module (input validation adds `INVALID_ADDRESS`,
`INVALID_HASH`, `INVALID_AMOUNT`, `INVALID_HINT` and `INVALID_CHAIN`):

| Code | Meaning |
| --- | --- |
| `CHAIN_MISMATCH`, `REORG`, `CODE_MISMATCH`, `AUCTION_BINDING_MISMATCH` | RPC chain, observation or contract bindings differ from the manifest |
| `AUCTION_BINDINGS_REQUIRED`, `INVALID_BID_RULES` | The manifest lacks a pin or its `bidRules` are not the compiled rules |
| `UNSUPPORTED_AUCTION` | The deal does not belong to this deployment |
| `AUCTION_NOT_OPEN`, `EXPIRED_DEADLINE` | Not accepting bids; deadline is in the past |
| `BID_TOO_LOW`, `INVALID_BID_PRICE`, `INVALID_BID_QUOTE` | Below 20 USDC; price off the grid, not above clearing or above the CCA ceiling; inconsistent router quote |
| `TERMS_NOT_ACCEPTED`, `CREATOR_BID_NOT_ALLOWED` | Wallet has not accepted the terms; creator or controller cannot bid |
| `WALLET_BID_LIMIT`, `WALLET_CAP_EXCEEDED` | No free bid slot; above the wallet's ceiling or token cap |
| `REBID_NOT_AVAILABLE` | The bid is not outbid and unexited, or the minimum raise is not met |
| `WITNESS_UNAVAILABLE`, `TICK_UNAVAILABLE`, `WALLET_STATE_UNAVAILABLE` | Chain history or state needed for the transaction could not be proven |
| `INSUFFICIENT_BALANCE`, `APPROVAL_REQUIRED` | Raised by `simulate: true` before the call |
| `NOT_CLAIMABLE`, `ALREADY_EXITED` | Claim before exit or without allocation; exit already done |

## Mainnet

Use a reviewed manifest with real USDC and the full set of pins. `mainnet.template.json` is
deliberately non-executable; final addresses, bytecode, bindings and on-chain behavior must
be verified on the actual mainnet release. See [mainnet inputs](mainnet.md). Trading the
resulting markets is in [markets](markets.md); the pure launch-floor rules are in
[launch](launch.md). Examples: [auction.ts](../examples/auction.ts),
[dynamic-bid.ts](../examples/dynamic-bid.ts).
