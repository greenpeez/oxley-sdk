# Current Markets

Available since `@oxley/sdk@0.6.0-next.1`. Earlier releases bound one curve, the flat-fee
release, so they could not trade the markets that launched on newer curves. This guide
covers `createOxleyMarkets`, which routes each market to the curve that holds it, plus
the Gen3 and Gen8 behaviors an integrator meets: terms acceptance, the trading gate and
the decaying opening surcharge. Trading fees you add on top are in
[integrator fees](integrator-fees.md); Gen8 bidding is in [auctions](auctions.md#gen8-dynamic-bids).

## Supported Generations

Testnet, chain `99801`, Oxy-USDC. Counts are `MarketActivated` events read from each curve
on 2026-10-29 and will grow.

| Generation | Release | Curve | Activated markets | Notes |
| --- | --- | --- | --- | --- |
| `flat-fee` | `elysium-auctions-flat-fee-7006d7889ab293d3` | `0x18bf92514c0d749a017aaf69153442703e1a966b` | 8 | MAYHEM, GNX, EUSEXUA, IRON, RAINBOW, DOBUN, KPROOF, THOR. No terms, no gate. |
| `gen3` | `elysium-auctions-gen3-aac49c62c3855f41` | `0xb7e3e9b2ea74e3051f5c40ce7eb0486b0ab793d3` | 13 | G3CHECK, CATE, GATE, BG, FIRE, MESSI, YUI, 12, MILADY, OB, MGN, BEAR, VT. Terms, gate, opening surcharge. |
| `gen8` | `elysium-auctions-gen8-969bd0e317da4145` | `0x434fd4f556800634399b9f96a4d148de215458e5` | 0 | The current launch generation. Quote-only curve. Its first auction (G8TEST) failed, so no market is active yet. |

Manifests: `deployments/elysium-testnet.json`, `elysium-testnet-gen3.json` and
`elysium-testnet-gen8.json`, each verified by runtime code hash exactly like the original
flat-fee manifest. They are bundled as `testnetDeployments`, so no file access is needed.

Not supported, and why:

- **Gen2** (`elysium-auctions-gen2-4f28738faf30190d`): all 14 of its auctions failed, so its
  curve holds no market. `deployments/elysium-testnet-gen2.json` keeps its fork-rehearsal
  addresses (`planned-fork-addresses`) and still fails closed.
- **Bonded-v2 and older curves**, which hold the original PENELOPE, ODYSSEUS, RODEO and MINI
  markets (curve `0x09cbc6c279376107f59c8609286adfbe16bfa323`). They are a deprecated family
  with several controllers and no reviewed manifest in this SDK. The flat-fee client never
  reached them; their IDs resolve to `UNSUPPORTED_MARKET`.

## Resolve And Trade

```ts
import { createPublicClient, http } from 'viem';
import { createOxleyMarkets } from '@oxley/sdk';

const markets = createOxleyMarkets({
  publicClient: createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') }),
});
await markets.verifyDeployments(); // pins, bindings, terms registry, decimals for every generation

const { market, entry } = await markets.resolveMarket(dealId); // entry.generation: 'flat-fee' | 'gen3' | 'gen8'
const swap = await markets.prepareSwap({ marketId: dealId, tokenIn: market.quoteToken, tokenOut: market.coin,
  amountIn: 10_000_000n, caller: wallet, slippageBps: 50 });
const funding = await markets.checkSwap(swap); // routed by swap.quote.releaseId
```

**How a market is resolved.** `resolveMarket(dealId)` asks every generation concurrently:
its registry must list the deal as profile `Cca`, status `Active`, with that generation's
controller and the quote token as reserve, and its curve's `market(dealId)` must be active
with the same coin and creator. Exactly one generation may match. Nothing is inferred from a
symbol, a token address or an HTTP response.

- No match: `UNSUPPORTED_MARKET` (`details.checked` lists the releases asked). A failed read or
  a failed verification in a generation is rethrown instead, never reported as "not found".
- Two matches: `AMBIGUOUS_MARKET`. A hit in one generation stands even if another could not be read.
- A successful resolution is remembered for the life of the object.
- `resolveMarket(dealId, { identity })` accepts the data API's `deploymentIdentity` (or any
  `{ chainId?, curve: { address, runtimeCodeHash? } }`). It only picks the candidate: an
  identity that matches no reviewed curve is `UNKNOWN_DEPLOYMENT`, and one whose curve does not
  list the deal on chain is `IDENTITY_MISMATCH`. Public catalog rows often carry
  `deploymentIdentity: null`; resolve those without it.

Everything else routes the same way: `quote`, `prepareSwap`, `prepareSwapWithFee`,
`getTradingStatus`, `getTermsStatus` and `prepareAcceptTerms` by market; `checkSwap` and
`checkSwapWithFee` by the release that prepared the swap. `markets.client('gen3')` (or a
release ID) returns the single-deployment client from `createOxleyClient`, which is still
exported and unchanged for the flat-fee manifest.

`discoverMarkets({ cursors?, pageSize?, ... })` scans each generation's `MarketActivated`
events from its start block, at most 10,000 blocks per page per generation, and returns
`cursors` to resume. A complete history needs many pages: use the indexed
[data API](data-api.md) to display catalogs and `resolveMarket` for the deal a user picks.

## What Differs By Generation

| | flat-fee | Gen3 | Gen8 |
| --- | --- | --- | --- |
| `quoteBuy` / `quoteSell` | `(id, amount, account)`; sell returns a collateral leg | same | `(id, amount)`; no account, no collateral leg |
| `sell` arguments | `id, coinIn, minQuote, minCollateral, deadline` | same | `id, coinIn, minQuote, deadline` |
| `market()` has a reserve asset | yes | yes | no (the registry's reserve is the quote token) |
| Trading gate | none | yes | yes |
| Terms registry on buy/sell | no | yes | yes |
| Opening surcharge on buys | no | yes | yes |

The SDK selects views and calldata from the market's generation (`market.generation`), and
`buildSwap` encodes by the quote's market, so a Gen8 quote can never produce a five-argument
sell. Quotes come from the curve's own views; the SDK never re-implements pricing. A Gen3
sell quote with a collateral leg is refused (`COLLATERAL_OUTPUT`), as before.

## Terms

Gen3 and Gen8 curves call `termsRegistry.requireAccepted(msg.sender)` on `buy` and `sell`.
Enforcement is off while the registry's `requiredVersion` is zero, which is the case on
both testnet registries today (nothing has been published). When it is turned on, a wallet
that has not accepted gets a `TermsNotAccepted` revert.

```ts
const status = await markets.getTermsStatus({ marketId: dealId, account });
// { enforced, accepted, requiredVersion, latestVersion, acceptedVersion, termsHash, uri, termsRegistry }
const { transaction } = await markets.prepareAcceptTerms({ marketId: dealId, account });
// null when nothing is required or the account already accepted; otherwise an unsigned,
// simulated acceptTerms(requiredVersion, termsHash) for the registry the curve is bound to.
```

Accepting is the user's own legal act: show the text at `uri`, check that its keccak256
equals `termsHash`, and send the transaction from the user's wallet. Flat-fee curves report
`termsRegistry: null, accepted: true`. `checkSwap` and `checkSwapWithFee` return
`termsAccepted` and `terms`, and refuse to simulate (`TERMS_NOT_ACCEPTED`) until the account
has accepted. `buildAcceptTerms({ chainId, termsRegistry, version, termsHash })` encodes the
call offline. The SDK does not relay gasless acceptances.

## Trading Gate And Opening Surcharge

After settlement a Gen2+ curve stays closed until every bid is delivered, or five minutes
after activation at the latest (Gen3, Gen8). Quotes and swaps fail closed with
`TRADING_NOT_OPEN`; `getTradingStatus(marketId)` returns `{ gated, open, fallbackAt }`.

Buys on Gen3 and Gen8 pay the standard 2% plus a surcharge that starts at 18% at the trading
opening and halves every 10 seconds, with linear steps in between, reaching zero at 60
seconds. The total buy fee is therefore 20% at the opening, 15.5% at 5 s, 11% at 10 s, 4.25% at 30 s and 2% from 60 s.
Sells never pay it. The curve's `quoteBuy` already includes it, so `quote.feeAmount` and
`quote.amountOut` are the real figures at the quote block and `quote.openingSurchargeWad` reports the
rate that was applied (WAD, 1e18 = 100%). Execution happens later, so the charged rate can only be
lower; your minimum output is built from the quote and stays safe. Two consequences:

- **Gen8 starts the clock at the first successful trade**, not at activation. Until a trade
  or `syncTradingOpened` records it, the quote shows the full 18% surcharge, and the first
  buyer pays it. Show this to users before the first buy in a Gen8 market.
- Elysium mines no empty blocks, so the head block (and therefore the quote's clock) can be
  hours old on a quiet chain. Treat quotes as upper bounds on the surcharge, not as live timers.

For countdowns, `openingSurchargeWadAt(elapsedSeconds)`, `openingSurchargeAmount(gross, rate)` and
`buyFeeBps(rate)` mirror the contract schedule; `scripts/check-markets-testnet.ts` proves
the mirror equals `surchargeWadAt` on both curves. The curve stays the authority.

## Errors

`OxleyError.code` values added or widened in this release: `UNSUPPORTED_MARKET`,
`AMBIGUOUS_MARKET`, `UNKNOWN_DEPLOYMENT`, `IDENTITY_MISMATCH`, `TERMS_NOT_ACCEPTED`,
`TERMS_BINDING_MISMATCH`, `TERMS_ACCEPTANCE_REVERTED`, `INVALID_TERMS_STATE`,
`TRADING_NOT_OPEN`. `decodeOxleyRevert(error, { generation })` also decodes `TermsNotAccepted`,
`BuysPaused`, `MinimumNotMet`, `DeadlineExpired`, `QuoteDust`, `CapitalShortfall` and the
Gen8 bid errors into short messages.

## Verification

`npm run test:live:markets` is a read-only check against the public testnet RPC: it verifies
all three generations, resolves live flat-fee and Gen3 markets, quotes and prepares fee-bearing
swaps (buys and sells) without any balance, checks the batches, reads terms state, compares the
surcharge mirror with both curves, and verifies the Gen8 auction graph. It signs and sends nothing.
