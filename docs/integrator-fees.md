# Integrator Fees

Available since `@oxley/sdk@0.6.0-next.1`. A wallet, aggregator or app that routes Oxley
trades can take its own fee in Oxley's quote asset (Oxy-USDC on testnet, USDC on mainnet) on
top of the protocol's fees. The contracts have no integrator-fee field and the SDK adds none:
the fee is an ordinary token transfer that travels with the trade in one call batch. It never
touches the curve, the protocol fees or the user's minimum output.

```ts
import { createOxleyMarkets } from '@oxley/sdk';

const markets = createOxleyMarkets({ publicClient });
const prepared = await markets.prepareSwapWithFee({
  marketId, tokenIn: market.quoteToken, tokenOut: market.coin,
  amountIn: 10_000_000n,          // buy: the user's TOTAL spend, 10 Oxy-USDC, fee included
  caller: wallet, slippageBps: 100,
  feeRecipient: '0xYourTreasury', feeBps: 50,   // 0.5%; 1 to 100 allowed
});

prepared.fee;   // { recipient, bps: 50, token, amount: 50_000n, basis: 'input', basisAmount: 10_000_000n }
prepared.calls; // ordered: fee-transfer, [approve-reset], approve, trade
prepared.spend; // { token: quote token, amount: 10_000_000n }
prepared.receive; // { token: coin, expected, minimum }   (coins; the fee is paid on top of them)

const ready = await markets.checkSwapWithFee(prepared); // re-quote and re-verify every call
// Wallets with EIP-5792 support:
await provider.request(prepared.batch);   // { method: 'wallet_sendCalls', params: [...] }
```

## Semantics

| | Buy (quote token in) | Sell (coin in) |
| --- | --- | --- |
| `amountIn` | Total spend including the fee | Coin amount |
| Fee basis | `amountIn` | The guaranteed minimum output `swap.minAmountOut` |
| Fee | `floor(amountIn * feeBps / 10000)` | `floor(minAmountOut * feeBps / 10000)` |
| Traded on the curve | `amountIn - fee` (the quote is requested for this amount) | `amountIn` |
| Call order | fee transfer, approvals, trade | approvals, trade, fee transfer |
| User receives | coins quoted for the net amount | quote token: curve output minus the fee |

- **Buys.** The fee leaves the user's wallet first, the curve is approved for exactly the net
  amount (a zero-reset first if a smaller nonzero allowance exists, as in `checkSwap`), then the
  curve buys with the net amount. The quote, and so `minAmountOut`, are for the net amount.
- **Sells.** The curve pays the user, then the fee is transferred from the user's wallet. The fee
  is computed on the **minimum** output, not on what the sale actually pays. The trade reverts
  if it pays less than the minimum, so the user always holds at least the fee afterwards; an
  output above the minimum is the user's. Documented consequence: the integrator earns slightly
  less than `feeBps` of the real output whenever the price improves between quote and
  execution. `receive.minimum` already has the fee deducted.
- **Rounding.** Fees round down, like the protocol's. A fee that rounds to zero omits its transfer
  (`fee.amount === 0n`, no `fee-transfer` call) instead of sending nothing.
- **Fee asset.** Always the market's quote token. There is no native-asset or coin-denominated fee.

## Validation

Refused before any quote or signature: `feeBps` that is not an integer from 1 to
`MAX_INTEGRATOR_FEE_BPS` (100); an invalid or zero `feeRecipient`; a recipient that is the
curve, the quote token, the market's coin or any contract in the deployment manifest
(registry, controller, terms registry, bid router, adapter, hook); a zero or oversize
`amountIn`; a lifetime outside 1 to 3600 seconds. A fee recipient equal to the caller is allowed
(for example when testing with one wallet). For no fee, use `prepareSwap`.

## Atomic Batch And Sequential Fallback

`prepared.batch` is an EIP-5792 `wallet_sendCalls` request (`version: '2.0.0'`) with
`atomicRequired: true` unless you pass `atomicRequired: false`. A wallet that cannot execute the
calls atomically rejects it (EIP-5792 error 5760); it is **only atomic where the wallet supports
batching**. viem users can pass `prepared.calls.map(c => c.transaction)` to `sendCalls`.

`prepared.sequential` holds the same calls for wallets without batching, with `atomic: false` and
this warning, also exported as `SEQUENTIAL_FEE_WARNING`:

> Not atomic: every call is a separate transaction. A buy transfers the fee BEFORE the trade, so
> if the trade then fails the user has already paid the fee. A sell transfers the fee AFTER the
> trade, so if that transfer fails the integrator is unpaid.

If you offer the sequential path, confirm each receipt before sending the next call, requote
after approvals, and tell the user what a mid-way failure leaves behind. Smart-contract wallets
that execute the batch themselves keep the same ordering.

## Checking A Batch

`checkSwapWithFee(prepared, simulate?)` re-quotes at the current block and **re-derives every
call** from the prepared market, amounts, minimum, deadline, fee terms and the current
allowance. It refuses (`SWAP_MISMATCH`, with `details.index` of the first differing call) any
altered, reordered, stale or incomplete batch, a tampered `sequential` list or EIP-5792
payload, and, as `checkSwap` does, a swap that belongs to another deployment (`SWAP_MISMATCH`),
an expired one (`EXPIRED_DEADLINE`) or one whose output fell below its minimum (`SLIPPAGE`).
An allowance that changed since preparing makes the approval calls stale: prepare again.

It returns the block, `balance`, `allowance`, pending `approvals`, `sufficientBalance`,
`termsAccepted`, the verified `calls` and `fee`. With `simulate: true` it also needs the full
input in the wallet, no pending approvals and accepted terms, then simulates and gas-estimates the
**curve trade only**: an atomic batch cannot be simulated with a plain `eth_call`, and the plain
token transfer needs no simulation beyond the balance check.

`buildSwapWithFee(quote, options)` is the offline form: its `quote` must be for the traded
amount (net for buys) and `options.amountIn` is the user's total input. A mismatch is refused.

## Scope

Fees apply to the direct, self-custodied swap path where the user's own wallet sends the calls.
They are not part of the 0x BASIC action, where the provider's executor is the immediate caller
(see [0x routing](0x.md)). Gen3 and Gen8 curves also require the user to have accepted the
terms; see [terms](markets.md#terms). The SDK does not sign, submit or custody anything, and the
integrator is responsible for disclosing its fee to the user.
