# Oxley SDK

Public, provider-neutral TypeScript SDK for Oxley on Elysium. It supports one contract
release, **Gen10**: Dynamic Bid auctions, the markets they create, and the swaps, quotes and
terms of those markets. Everything is read from chain through a caller-supplied viem public
client and returned as **unsigned** calldata; the SDK never signs, broadcasts or holds keys.
It runs in Node.js 20+ and browser applications, with no Oxley API key, backend, callback,
provider allowlist or Uniswap v4 hook.

This repository contains the **Elysium SDK**, version `0.7.0-next.0`, as ESM with
TypeScript declarations. It is a breaking release: the earlier flat-fee, Gen2, Gen3, Gen8
and Gen9 support, `createOxleyMarkets` and the launch client are gone (see the
[changelog](CHANGELOG.md) for the removals and an old to new table of renamed exports).
It is a different API from the legacy `@oxley/sdk` `0.4.1` release, whose
`@oxley/sdk/release` and `@oxley/sdk/evm` consumers should stay on `0.4.1`. The prerelease
version does not imply mainnet readiness: the included manifest and public feeds are
testnet only (chain id 99801), and mainnet bindings are pending.

```sh
npm install @oxley/sdk
```

## For AI Agents And Bots

An agent can run the whole auction lifecycle with a public RPC and its own wallet:

| Step | Call | Result |
| --- | --- | --- |
| Check the deployment | `auctions.verifyDeployment()` | Pins, bindings, bid rules, floor cap and minimum raise verified at one block |
| Read limits | `auctions.getDynamicBidLimits({ dealId, owner })` | Wallet ceiling, allowance, live-bid slots, balance, terms standing, `maximumBid` |
| Prepare a Dynamic Bid | `auctions.prepareDynamicBid({ dealId, caller, entered, maxPriceQ96 })` | Exact approvals and the bid transaction, with witnesses and a derived previous tick |
| Simulate | the same call with `simulate: true` | The router call simulated from `caller` once balance and approvals exist |
| Rebid | `auctions.prepareDynamicRebid({ ..., oldBidId })` | Exits one outbid bid and bids again in one transaction |
| Refund | `auctions.prepareRefund({ dealId, bidId, caller, partialFill? })` | Unsigned exit, simulated; principal goes to the bid's owner |
| Claim | `auctions.prepareClaim({ dealId, bidId, caller })` | Unsigned token claim, simulated, after the exit is confirmed |

Each result carries structured errors (`OxleyError.code`, `details`) so an agent can branch
without parsing text, and `decodeOxleyRevert` turns a wallet or RPC revert into a short
reason. The agent signs and sends every transaction itself, confirms receipts, and prepares
again from fresh chain state; a timeout is never proof that nothing was sent. Work through
[the auction guide](docs/auctions.md) and its [example](examples/dynamic-bid.ts).

## Start Here

- [Public Builders docs](https://oxley.fun/docs/builders) and [npm package](https://www.npmjs.com/package/@oxley/sdk).
- Auction participation: [Dynamic Bids, rebids, claim and refund guide](docs/auctions.md) and examples ([bid and rebid](examples/dynamic-bid.ts), [exit and claim](examples/auction.ts)).
- Trading the markets auctions create, terms and the opening surcharge: [markets](docs/markets.md).
- Aggregators and exchanges: [provider handoff](docs/provider-handoff.md), [0x source guide](docs/0x.md), [mainnet requirements](docs/mainnet.md).
- Wallets and apps adding their own fee: [integrator fees](docs/integrator-fees.md) and [example](examples/integrator-fee.ts).
- Frontend builders: [indexed data API](docs/data-api.md) and [polling example](examples/live-data.ts).
- Launch floors: [launch floor rules](docs/launch.md) and [example](examples/launch-floor.ts).
- Evidence: [validation overview](docs/validation.md), [auction tests](docs/auction-validation.md), [live data checks](docs/data-validation.md).

## Release Channel

Normal releases publish to `latest`, which controls the default npm page and
unversioned installs. Use an explicit `--tag next` only for an opt-in preview.
Promote an already-published release without republishing its code:

```sh
npm dist-tag add @oxley/sdk@<version> latest
npm view @oxley/sdk version dist-tags
```

Published version archives are immutable; older archives may still describe the
release channel that applied when they were published. The registry's current
dist-tags determine the default version.

## Entry Points

| Import | Contents |
| --- | --- |
| `@oxley/sdk` | Trading client (`createOxleyClient`), swaps and integrator fees, terms, opening-surcharge mirror, `parseDeployment`, `testnetDeployment`, `decodeOxleyRevert`, the raise constants and typed ABIs |
| `@oxley/sdk/auctions` | `createOxleyAuctionClient`, Dynamic Bid and rebid builders, claim and refund builders, the bid-rule helpers and constants, typed auction ABIs |
| `@oxley/sdk/launch` | Pure launch-floor rules (`validateLaunchFloor`, `minimumRaiseFloor`, `quoteAuctionFloor`); the SDK does not prepare launch transactions |
| `@oxley/sdk/abis` | Every typed ABI subset |
| `@oxley/sdk/0x` | `buildZeroExBasic`, the optional 0x BASIC source action |
| `@oxley/sdk/data` | `createOxleyDataClient`: fetch-only client for the public indexed data API |
| `@oxley/sdk/abis/*.json` | Full compiler ABIs: `curve`, `bid-router`, `bid-hook`, `terms-registry`, `cca-auction` |
| `@oxley/sdk/deployments/*.json` | `elysium-testnet.json` (reviewed Gen10 testnet manifest) and `mainnet.template.json` |

## Auctions

`createOxleyAuctionClient` binds one reviewed deployment. Bids target the accepted-bid
router and are checked by the per-wallet bid hook; the SDK reads the wallet's standing,
builds one witness per stored bid, and refuses what the hook, router or auction would refuse
before it returns a transaction.

```ts
import { createPublicClient, http } from 'viem';
import { testnetDeployment } from '@oxley/sdk';
import { createOxleyAuctionClient } from '@oxley/sdk/auctions';

const auctions = createOxleyAuctionClient({
  deployment: testnetDeployment,
  publicClient: createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') }),
});
const limits = await auctions.getDynamicBidLimits({ dealId, owner });
if (limits.maximumBid >= limits.minimumBid) {
  const prepared = await auctions.prepareDynamicBid({ dealId, caller: owner, entered: limits.minimumBid, maxPriceQ96 });
  // prepared.approvals in order, then prepare again with simulate: true and send prepared.transaction.
}
```

- A bid is at least 20 USDC of principal; a 0.1% accepted-bid fee is charged on top.
- A wallet holds at most 3 live bids and 12 bids in total per auction, up to 30,000,000 coins, and up to a ceiling that opens at $3,030.303031 and grows with other wallets' commitments.
- The terms must be accepted first (`getTermsStatus`, `prepareAcceptTerms`); creators cannot bid on their own auction.
- A rebid exits one outbid bid and bids again, once the auction has met its minimum raise.
- Refunds and claims always pay the recorded bid owner, even when another account submits; partial-fill exits need explicit CCA checkpoint hints, and an exit must be confirmed before claiming.
- Auctions succeed or fail by their minimum raise: a controller `minimumRaise()` of 30,000 USDC net (30,303,030,303 gross), a launch floor capped at 1e21 `floorPriceWad`.

See [auction integration](docs/auctions.md) and [auction validation](docs/auction-validation.md).

## Markets, Terms And Swaps

Once an auction succeeds its coin trades on the Gen10 curve. `createOxleyClient` binds the same
deployment, discovers active markets from `MarketActivated` events, reads executable exact-input
quotes and builds unsigned ERC-20 approvals and atomic buy and sell calldata.

```ts
import { createPublicClient, http } from 'viem';
import { createOxleyClient, testnetDeployment } from '@oxley/sdk';

const sdk = createOxleyClient({
  deployment: testnetDeployment,
  publicClient: createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') }),
});
await sdk.verifyDeployment();
const page = await sdk.discoverMarkets();
// Persist page.cursor; keep requesting pages while page.hasMore is true.
// No markets on a page does not mean there are no later activations.
const market = page.markets[0];
if (!market) throw new Error('Continue discovery until an active market is found');

const swap = await sdk.prepareSwap({
  marketId: market.id,
  tokenIn: market.quoteToken,
  tokenOut: market.coin,
  amountIn: 10_000_000n, // 10 USDC (Oxy-USDC on testnet), six decimals
  caller: '0xYOUR_WALLET_OR_ACTUAL_EXECUTOR_ADDRESS',
  slippageBps: 50,
  ttlSeconds: 300,
});

// For a directly funded caller:
const funding = await sdk.checkSwap(swap);
// Submit funding.approvals in order, wait for successful receipts, then requote.
// checkSwap(freshSwap, true) simulates and estimates gas with real balances.
// Sign and send freshSwap.transaction using the caller's existing wallet.
```

`quote()` accepts the same market, pair, input and caller fields without slippage and returns net
`amountOut`, the USDC-denominated `feeAmount`, the opening surcharge rate on buys, and the source
block and hash. It needs neither input balance nor allowance. `quoteMany()` samples up to 64 inputs
at one block, four in flight at a time, preserving per-sample errors. RPC failures are not
liquidity-zero results. Quotes are observations, not price reservations; deadline and minimum
output are enforced at execution. Read [markets](docs/markets.md) for the curve interface, the
trading gate that keeps a new market closed until its bids are delivered, the decaying opening
surcharge and the market checks.

**Terms.** The curve and the bid hook require the caller to have accepted the Oxley terms once the
bound registry enforces them. `getTermsStatus(account)` reports `{ enforced, accepted, requiredVersion,
termsHash, uri }`, `prepareAcceptTerms({ account })` returns an unsigned, simulated
`acceptTerms(version, termsHash)` (or `null`), `buildAcceptTerms` encodes it offline, and `checkSwap`
returns `termsAccepted` and refuses to simulate before acceptance. Show the user the text at `uri`
before they sign; see [terms](docs/markets.md#terms).

**Integrator fees.** `prepareSwapWithFee` adds your own fee, in the quote asset, to a direct trade
without touching the protocol fees or the user's minimum output. It returns an ordered call batch for
EIP-5792 `wallet_sendCalls` (atomic only on wallets that support batching) and the same calls as a
sequential fallback with its risk stated. `feeBps` is an integer from 1 to `MAX_INTEGRATOR_FEE_BPS`
(100). Full semantics, rounding and the atomicity caveat: [integrator fees](docs/integrator-fees.md).

## Indexed Data

`@oxley/sdk/data` is a separate, fetch-only browser/Node client for public indexed
auctions, bids, activity, trade history, exact volume, chart candles and token details. No wallet
or RPC client is needed. It requires the deployed public data API, not an RPC URL.

```ts
import { createOxleyDataClient, isCurrentData } from '@oxley/sdk/data';

const data = createOxleyDataClient({
  baseUrl: 'https://app.oxley.fun/api/data/v1',
  chainId: 99801,
});
const auctions = await data.auctions({ model: 'cca', limit: 20 });
if (isCurrentData(auctions)) console.log(auctions.items);
```

Names, descriptions, social links and images come from `tokens`, which takes any number of deal IDs
(the client sends 50 per request and merges the answers) and leaves out the ones the API does not list:

```ts
const dealIds = auctions.items.map(auction => auction.dealId);
const { items } = await data.tokens({ ids: dealIds });
for (const token of items) console.log(token.name, token.symbol, token.image?.url ?? 'no image yet');
const unlisted = dealIds.filter(id => !items.some(token => token.dealId === id));
```

See the [public data API guide](docs/data-api.md) for every endpoint, model
selection, numeric units, pagination, freshness, polling and release limitations.
The [frontend example](examples/live-data.ts) handles cancellation and cooldowns.
These feeds are for display, **not transaction preparation or signing authority**.

## Independent Quotes And Minimums

Use `quote()` or `prepareSwap()` with your independently configured RPC and the
reviewed deployment manifest, not an HTTP quote or an indexed-data response as
signing authority. The minimum is computed locally as
`floor(amountOut * (10000 - slippageBps) / 10000)` using bigint; a zero minimum is
rejected. Comparing two backend-provided numbers does not authenticate either.

Keep the user's input, selected pair, actual caller, deadline and slippage policy
bound to the prepared transaction. Confirm approvals, obtain a fresh quote, and
call `checkSwap(freshSwap, true)` before handing off to the wallet. That check does
not silently lower the signed minimum. Refuse stale/failed reads, handle RPC
cooldowns, and never fall back to a server-provided floor. The SDK does not own
your wallet journal: preserve a submitted hash or unknown outcome across reloads
and reconcile it before retrying. A timeout is not proof that nothing was sent.

## API

| Method/export | Result |
| --- | --- |
| `parseDeployment(json)` | Validated, frozen manifest: nine distinct pinned contracts and the exact bid rules |
| `createOxleyClient({publicClient,deployment})` | Independent RPC trading client; no hosted Oxley service |
| `verifyDeployment()` | Chain, runtime hash, quote binding, decimals and terms-registry binding checks |
| `discoverMarkets({cursor?,fromBlock?,toBlock?,pageSize?,coin?})` | Event-based page of active markets and canonical cursor |
| `getMarket(id, blockNumber?)` | Registry/curve-validated market and block identity |
| `getTradingStatus(id, blockNumber?)` | Trading gate `{open, fallbackAt}` |
| `quote(request)`, `quoteMany(requests, blockNumber?)` | Exact-input quote for one market/pair, or ordered settled results at one block |
| `prepareSwap({...request,slippageBps,ttlSeconds?})` | Fresh quote, transaction, required approval, output/reward receiver |
| `checkSwap(swap, simulate?)` | Current price/funding/terms checks, exact approvals, optional simulation/gas |
| `buildSwap(quote,{slippageBps,deadline})`, `buildApprovals(swap,currentAllowance)`, `minimumAmountOut(amountOut,slippageBps)` | Offline encoders; none refreshes or authenticates a supplied quote |
| `getTermsStatus(account)`, `prepareAcceptTerms({account})`, `buildAcceptTerms(...)` | Terms standing, unsigned simulated `acceptTerms`, offline encoder |
| `prepareSwapWithFee({...request,feeRecipient,feeBps})`, `checkSwapWithFee(prepared,simulate?)` | Ordered fee-bearing call batch, EIP-5792 request and sequential fallback; re-quote and re-derive every call |
| `buildSwapWithFee(quote,options)`, `integratorFeeAmount(basis,bps)` | Offline builder and fee arithmetic (`MAX_INTEGRATOR_FEE_BPS = 100`) |
| `openingSurchargeWadAt(seconds)`, `buyFeeBps(rate)` | Mirror of the curve's decaying opening surcharge schedule |
| `createOxleyAuctionClient({publicClient,deployment})` from `@oxley/sdk/auctions` | `verifyDeployment`, `getAuction`, `getDynamicBidLimits`, `prepareDynamicBid`, `prepareDynamicRebid`, `prepareClaim`, `prepareRefund` |
| `buildDynamicBid`, `buildDynamicRebid`, `buildAuctionClaim`, `buildAuctionRefund`, `buildAuctionBidApprovals` | Offline encoders for the same transactions |
| `MIN_BID`, `TOKEN_CAP`, `MAX_LIVE_BIDS`, `MAX_WALLET_BIDS`, `BID_RULES`, `bidRefusal`, `walletCeiling`, ... | Bid rules and the pure helpers that mirror the hook |
| `validateLaunchFloor(floor)`, `minimumRaiseFloor()`, `floorReachesMinimumRaise(floor)`, `quoteAuctionFloor(floor)` from `@oxley/sdk/launch` | Pure floor rules: the lowest floor that can raise $30,000 and the 1e21 cap |
| `MINIMUM_NET_RAISE`, `MINIMUM_GROSS_RAISE`, `MAX_FLOOR_PRICE_WAD` | The controller's 30,000e6 net and 30,303,030,303 gross minimum raise and its floor cap |
| `buildZeroExBasic(swap,proportionPpm?)` from `@oxley/sdk/0x` | Optional BASIC source action, not a complete user transaction |
| `decodeOxleyRevert(errorOrData,{quoteSymbol?})` | Pure decoder for Oxley rule reverts (terms, curve trades, gate, Dynamic Bids, floor cap) into `{name,args,message}`, else `null` |

All amounts use bigint base units, not floating point. Coin precision is 18;
USDC/Oxy-USDC precision is 6. Use viem `parseUnits`/`formatUnits` at UI boundaries.
Serialize bigint values as decimal strings at JSON boundaries.

## Integration Semantics

- The trading client exposes only active registered markets against the configured
  USDC quote asset. Auction bids, rebids, principal refunds and token claims are prepared
  by the separate `/auctions` client; they are not atomic swap routes. The `/data` client
  is read-only. No SDK client signs or broadcasts.
- Bridge transfers, mint and twin markets, native-asset bid or trade payments and
  exact-output trading remain outside the package's scope.
- A market is identified by `(chainId, curve, marketId)`. Do not assume token
  symbols are identities.
- Native on-chain reads are `quoteBuy(id,amount)` and `quoteSell(id,amount)`, both
  `external view` and independent of the caller. The SDK normalizes pairs; there is no
  `quote(tokenIn,tokenOut,amountIn)` contract.
- Native swaps are `buy(id,amount,minimumOut,deadline)` and `sell(id,amount,minimumOut,deadline)`.
  Input is pulled from, and output is paid to, the immediate caller. An aggregator uses its
  executor as caller, then performs its usual final payout. No callback is invoked on the provider.
- **Rewards also use the immediate caller.** Direct wallets retain their buying
  reward identity. An intermediary is recorded for routed buys; the SDK cannot
  infer or authenticate its end user. Do not advertise end-user reward eligibility
  for generic aggregator routes. This is existing contract behavior, not an SDK fee.
- Approval is a separate transaction unless the provider already has an atomic
  funding mechanism. Confirm approvals and requote before submitting.
- Ordinary buys and sells, fees and reward accounting revert together on failure. A
  treasury transfer failure may defer treasury payment according to the existing fee contract.
- Buying can be paused while sells remain available. Propagate contract errors;
  do not report failed simulation as a successful trade.

## Networks And Trust

The bundled testnet manifest identifies the Gen10 auction graph on chain 99801. The mainnet
template intentionally fails validation until actual mainnet values are supplied. Mainnet
requires USDC and a fresh contract graph bound to that token; changing an SDK address cannot
change an immutable deployed binding. There is no fallback between networks.

Contract hashes come from Oxley's release manifest. They authenticate a selected
deployment, not the economic authenticity of an arbitrary user-supplied manifest.
Oxley must supply the reviewed mainnet manifest. For proxy tokens such as USDC,
the proxy runtime hash is not proof that its implementation can never change.

The clients verify immutable contract pins on first use and on explicit
`verifyDeployment()`. Each operation checks the RPC chain and reads a single
numbered block with a final hash check. A reorg causes rejection; persist and
rewind discovery cursors to the last canonical checkpoint. Consumers choose
their finality policy through `toBlock`/`blockNumber`; `latest` is not finality.

See [the provider handoff](docs/provider-handoff.md), [0x routing](docs/0x.md),
[mainnet inputs](docs/mainnet.md) and [validation evidence](docs/validation.md).

## Build And Test

This package has its own lockfile and no workspace runtime dependencies:

```sh
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
npm run typecheck
npm test
npm run build
npm pack
# Validate the actual archive in a separate consumer project:
npm run test:package
# Create a shareable provider folder and .tar.gz at a new output path:
npm run bundle -- /path/to/oxley-provider-sdk
# Isolated local chain, never a remote/funded transaction:
ANVIL_BIN=/path/to/anvil npm run test:evm
# Optional public, read-only verification:
npm run test:live
npm run test:live:auctions  # the full Gen10 graph, bid-fee quote, optional auction and wallet limits
npm run test:live:markets   # live market, fee batches, terms and the surcharge mirror
npm run test:live:launch    # launch floor rules against the live adapter
# Regenerate src/testnet-deployment.ts after changing deployments/elysium-testnet.json:
npm run embed
```

The local EVM test places bids on a real vendor continuous clearing auction through retained
scaffolding contracts and executes the SDK's approval, exit and claim transactions. Tests and test
compiler dependencies are excluded from the npm archive. A source checkout includes reproduction
scripts.
