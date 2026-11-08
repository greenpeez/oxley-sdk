# Trading Markets

`createOxleyClient` is bound to one reviewed deployment: its curve, market registry, USDC
(Oxy-USDC on testnet) and terms registry. It discovers active markets, reads quotes from the
curve's own views, builds unsigned swaps and reads or prepares terms acceptance. Nothing
signs or sends: an app, bot or AI agent signs and sends the returned transactions with its own
wallet. Fees you add on top are in [integrator fees](integrator-fees.md); bidding
in the auction that creates a market is in [auctions](auctions.md).

## Connect

```ts
import { createPublicClient, http } from 'viem';
import { createOxleyClient, testnetDeployment } from '@oxley/sdk';

const sdk = createOxleyClient({
  deployment: testnetDeployment, // or the JSON at @oxley/sdk/deployments/elysium-testnet.json
  publicClient: createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') }),
});
await sdk.verifyDeployment();
```

`verifyDeployment()` checks, at one block: the runtime code hash of the curve, registry, USDC
and terms registry (`CODE_MISMATCH`); that the curve's quote asset is the pinned USDC with six
decimals (`QUOTE_BINDING_MISMATCH`); that the curve's terms registry is the pinned one
(`TERMS_BINDING_MISMATCH`); and that the block is still canonical (`REORG`). Every other call
verifies lazily once per client. The public RPC is rate-limited: use your own transport,
batching or pacing.

## Discover And Validate Markets

```ts
import type { DiscoveryCursor } from '@oxley/sdk';

let cursor: DiscoveryCursor | undefined;
for (;;) {
  const page = await sdk.discoverMarkets({ cursor, pageSize: 10_000 });
  for (const market of page.markets) console.log(market.id, market.coin, market.creator);
  cursor = page.cursor; // persist it to resume later
  if (!page.hasMore) break;
}
```

`discoverMarkets` scans the curve's `MarketActivated(dealId, coin, creator, quoteSeed)` events
from the deployment's start block, at most 10,000 blocks per page, and returns a
block-hash-checked `cursor` to resume from (`REORG` if it was reorganized, `INVALID_CURSOR`
for another deployment). Options: `cursor` or `fromBlock`, `toBlock`, `pageSize`, `coin`. A
complete history needs many pages: use the indexed [data API](data-api.md) to display
catalogs and `getMarket(dealId)` for the market a user picks.

A deal ID is a market only if, at one block, the registry lists it as profile `Cca` and
status `Active` with the deployment's controller and USDC as reserve, and the curve's
`market(dealId)` is active with the same coin and creator, a distinct 18-decimal coin. Nothing
is inferred from a symbol, a token address or an HTTP response. Anything else is
`UNSUPPORTED_MARKET`; `getMarket` returns `{ market, blockNumber, blockHash, timestamp }`.

## Curve Interface

| Call | Shape |
| --- | --- |
| `quoteBuy(id, grossQuoteIn)` | view; returns `(coinOut, feeAmount)` |
| `quoteSell(id, coinIn)` | view; returns `(quoteOut, feeAmount)` |
| `buy(id, grossQuoteIn, minimumCoinOut, deadline)` | exact input |
| `sell(id, coinIn, minimumQuoteOut, deadline)` | exact input; four arguments |

The curve is quote-only: it holds no reserve asset of its own and quote views take no account
argument (the fee does not depend on the caller). Outputs
are net of fees, so do not subtract fees again; `feeAmount` is in USDC base units on both
sides. Approvals, balances and output belong to the immediate caller. The full compiler ABI is
`@oxley/sdk/abis/curve.json`.

## Quote And Swap

```ts
const { market } = await sdk.getMarket(dealId);
const swap = await sdk.prepareSwap({ marketId: dealId, tokenIn: market.quoteToken, tokenOut: market.coin,
  amountIn: 10_000_000n, caller: wallet, slippageBps: 50 });
const funding = await sdk.checkSwap(swap); // balance, allowance, approvals, terms
// Send funding.approvals in order and wait for receipts; prepare a fresh swap, run
// checkSwap(fresh, true) to simulate, then send fresh.transaction from `wallet`.
```

- `quote({ marketId, tokenIn, tokenOut, amountIn, caller, blockNumber? })` accepts only the
  market's coin/USDC pair (`UNSUPPORTED_PAIR`) and refuses a quote with no output
  (`ZERO_OUTPUT`). It returns the amounts, `feeAmount` and, on buys, `openingSurchargeWad`.
  `quoteMany(requests, blockNumber?)` quotes 1 to 64 samples at one block and returns each as
  a settled result, never a plausible zero.
- `prepareSwap` adds `slippageBps` (0 to 9999) and `ttlSeconds` (1 to 3600, default 300) and
  returns the unsigned `transaction`, the exact `allowance` it needs, `minAmountOut` and
  `deadline`. A quote for a closed market fails closed (`TRADING_NOT_OPEN`).
- `checkSwap(swap, simulate?)` re-quotes and rebuilds the calldata. It refuses an expired swap
  (`EXPIRED_DEADLINE`), one from another deployment or with altered calldata (`SWAP_MISMATCH`)
  and an output below the minimum (`SLIPPAGE`). It returns `approvals` (exact, zero-first),
  `balance`, `allowance`, `sufficientBalance`, `termsAccepted` and `terms`; with `simulate` it
  also needs accepted terms, balance and confirmed approvals, then simulates and estimates gas.
- Offline: `buildSwap(quote, { slippageBps, deadline })`, `buildApprovals(swap, allowance)`
  and `minimumAmountOut(amountOut, slippageBps)`.

Quotes always come from the curve's own views; the SDK never re-implements pricing. For the
0x BASIC action see [0x](0x.md).

## Terms

The curve and the Dynamic Bids hook enforce one terms registry (`deployment.termsRegistry`).
Enforcement is off while the registry's `requiredVersion` is zero; once it is on, a wallet
that has not accepted gets a `TermsNotAccepted` revert on `buy`, `sell` and bids.

```ts
const status = await sdk.getTermsStatus(account);
// { enforced, accepted, requiredVersion, latestVersion, acceptedVersion, termsHash, uri, termsRegistry }
const { transaction } = await sdk.prepareAcceptTerms({ account });
// null when nothing is required or the account already accepted; otherwise an unsigned,
// simulated acceptTerms(requiredVersion, termsHash) for the registry the curve is bound to.
```

Accepting is the user's own legal act: show the text at `uri`, check that its keccak256 equals
`termsHash`, and send the transaction from the user's wallet. `buildAcceptTerms({ chainId,
termsRegistry, version, termsHash })` encodes the call offline. The SDK does not relay
gasless acceptances.

## Trading Gate And Opening Surcharge

After settlement the curve stays closed until every successful bid is delivered, or until its
timed fallback passes. `getTradingStatus(marketId)` returns `{ marketId, open, fallbackAt }`
plus the observation block; quotes and swaps fail closed with `TRADING_NOT_OPEN`
(`details.fallbackAt`).

Buys pay the standard 2% plus a surcharge that starts at 18% when trading opens, halves every
10 seconds with linear steps in between and is zero from 60 seconds. The total buy fee is 20%
at the opening, 15.5% at 5 s, 11% at 10 s, 4.25% at 30 s and 2% from 60 s. Sells never pay it.
The curve's `quoteBuy` already includes it, so `quote.feeAmount` and `quote.amountOut` are the
real figures at the quote block and `quote.openingSurchargeWad` (WAD, 1e18 = 100%) reports the
rate that was applied. Execution happens later, so the charged rate can only be lower and a
minimum output built from the quote stays safe.

- The curve records when trading opened (`opening(dealId)`, set by the first trade or
  `syncTradingOpened(dealId)`); until then a quote shows the full 18% surcharge. Show this to
  users before the first buy in a market.
- Elysium mines no empty blocks, so the head block, and the quote's clock with it, can be hours
  old on a quiet chain. Treat quotes as upper bounds on the surcharge, not as live timers.

For countdowns, `openingSurchargeWadAt(elapsedSeconds)`, `openingSurchargeAmount(gross, rate)`
and `buyFeeBps(rate)` mirror the schedule; `npm run test:live:markets` checks the mirror
against the curve's `surchargeWadAt`. The curve stays the authority.

## Errors

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_MARKET`, `UNSUPPORTED_PAIR`, `ZERO_OUTPUT` | Not an active market of this deployment; wrong token pair; no output |
| `TRADING_NOT_OPEN`, `INVALID_TRADING_GATE` | The gate is closed; gate state is inconsistent |
| `TERMS_NOT_ACCEPTED`, `TERMS_BINDING_MISMATCH`, `TERMS_ACCEPTANCE_REVERTED`, `INVALID_TERMS_STATE` | Terms standing and registry binding |
| `SWAP_MISMATCH`, `SLIPPAGE`, `EXPIRED_DEADLINE` | Re-check of a prepared swap failed |
| `INSUFFICIENT_BALANCE`, `APPROVAL_REQUIRED` | Raised by `checkSwap(swap, true)` before simulating |
| `INVALID_CURSOR`, `INVALID_PAGE_SIZE`, `INVALID_RANGE`, `BATCH_SIZE`, `INVALID_TTL`, `INVALID_SLIPPAGE` | Input limits |
| `CHAIN_MISMATCH`, `CODE_MISMATCH`, `QUOTE_BINDING_MISMATCH`, `REORG` | Deployment or observation differs from the manifest |

`decodeOxleyRevert(error)` turns on-chain reverts (`TermsNotAccepted`, `TradingNotOpen`,
`BuysPaused`, `MinimumNotMet`, `DeadlineExpired`, `QuoteDust`, `CapitalShortfall` and the
bid errors) into short messages.

## Verification

`npm run test:live:markets` is a read-only check against the public testnet RPC with no
signer: it verifies the trading deployment and the auction graph, compares the surcharge
mirror with the curve, and, when `OXLEY_MARKET_ID` names an activated market, quotes it and
prepares fee-bearing buys and sells without any balance.
