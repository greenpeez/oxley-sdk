# Oxley SDK

Public, provider-neutral TypeScript SDK for Oxley. The trading client discovers
active post-auction markets from chain events, reads executable exact-input quotes and
builds unsigned ERC-20 approvals and atomic buy/sell calldata. It runs in Node.js
and browser applications using a caller-supplied viem public client.

The trading client needs no Oxley API key, backend, signer, callback, provider allowlist, custom taker
accessor, or Uniswap v4 hook. Providers keep their usual funding,
transaction submission and final-recipient settlement. Fees are enforced by the
contracts even when the SDK is bypassed.

This repository contains the **Elysium SDK**, version `0.5.0-next.2`, as ESM with
TypeScript declarations. It is a different API from the legacy `@oxley/sdk`
`0.4.1` release. The Elysium release is the default `latest` channel. Its
prerelease version does not imply mainnet readiness. It is not a drop-in upgrade
for `@oxley/sdk/release` or `@oxley/sdk/evm` consumers; those integrations should
remain pinned to `@oxley/sdk@0.4.1` until migrated.

Install the Elysium SDK preview, including auction transactions and public data:

```sh
npm install @oxley/sdk
```

Version `0.5.0-next.0` provides trading integration, not the data client.
Mainnet bindings remain pending; the included manifest and public feeds are testnet only.

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

## Auction Transactions

`@oxley/sdk/auctions` adds `createOxleyAuctionClient`, unsigned bid/claim/refund
builders, exact fee-inclusive approvals, and typed auction ABIs. The client checks
runtime pins and the controller/router/adapter/auction bindings using your RPC.
It never signs, submits transactions, invents exit hints, or redirects payouts.

- Bids target the accepted-bid router, not the auction controller or raw CCA entry.
- Refund/exit and token-claim transactions target the auction resolved on-chain.
- Partial-fill exits require explicit CCA checkpoint hints; confirm an exit before claiming.
- The transaction caller owns a new bid. Refunds and claims always pay the recorded bid owner.

See [auction integration](docs/auctions.md), [example](examples/auction.ts), and
[auction validation](docs/auction-validation.md). Full compiler ABI JSON exports:
`@oxley/sdk/abis/auction-controller.json`, `auction-bid-router.json`,
`auction-adapter.json`, and `cca-auction.json` (all under `@oxley/sdk/abis/`).

## Indexed Data

`@oxley/sdk/data` is a separate, fetch-only browser/Node client for public indexed
auctions, bids, activity, trade history, exact volume and chart candles. No wallet
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

See the [public data API guide](docs/data-api.md) for every endpoint, model
selection, numeric units, pagination, freshness, polling and release limitations.
The [frontend example](examples/live-data.ts) handles cancellation and cooldowns.
These feeds are for display, **not transaction preparation or signing authority**.

## Quote And Prepare

```ts
import { createPublicClient, http } from 'viem';
import { createOxleyClient } from '@oxley/sdk';
import deployment from '@oxley/sdk/deployments/elysium-testnet.json'
  with { type: 'json' };

const sdk = createOxleyClient({
  deployment,
  publicClient: createPublicClient({
    transport: http('https://testnet-rpc.elysium.kinetiq.xyz'),
  }),
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
  amountIn: 10_000_000n, // 10 USDC/Oxy-USDC, six decimals
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

`quote()` accepts the same market/pair/input/caller fields without slippage and
returns net `amountOut`, USDC-denominated `feeAmount`, and the source block/hash.
It needs neither input balance nor allowance. `quoteMany()` samples up to 64
inputs at one block, four in flight at a time, preserving per-sample errors.
RPC failures are not liquidity-zero results. Quotes are observations, not price
reservations; deadline and minimum output are enforced at execution.

## API

| Method/export | Result |
| --- | --- |
| `parseDeployment(json)` | Validated, frozen network/token/contract configuration |
| `createOxleyClient({publicClient,deployment})` | Independent RPC client; no hosted Oxley service |
| `verifyDeployment()` | Chain, runtime hash, quote binding and decimals checks |
| `discoverMarkets({cursor?,fromBlock?,toBlock?,pageSize?,coin?})` | Event-based page of active auction markets and canonical cursor |
| `getMarket(id, blockNumber?)` | Registry/curve-validated market and block identity |
| `quote(request)` | Exact-input quote for one market/pair/caller |
| `quoteMany(requests, blockNumber?)` | Ordered settled results at the same block |
| `prepareSwap({...request,slippageBps,ttlSeconds?})` | Fresh quote, transaction, required approval, output/reward receiver |
| `checkSwap(swap, simulate?)` | Current price/funding checks, exact approvals, optional simulation/gas |
| `buildSwap(quote,{slippageBps,deadline})` | Offline encoder; does not refresh or authenticate a supplied quote |
| `buildApprovals(swap,currentAllowance)` | Exact allowance, with zero-first when necessary |
| `minimumAmountOut(amountOut,slippageBps)` | Integer slippage floor; rejects a zero minimum |
| `buildZeroExBasic(swap,proportionPpm?)` from `@oxley/sdk/0x` | Optional BASIC source action, not a complete user transaction |

All amounts use bigint base units, not floating point. Coin precision is 18;
USDC/Oxy-USDC precision is 6. Use viem `parseUnits`/`formatUnits` at UI boundaries.
Serialize bigint values as decimal strings at JSON boundaries.

## Integration Semantics

- Only active registered auction markets against the configured USDC quote asset
  are exposed by the trading client. Bid submission, delayed claims, bridges,
  mint/twin markets, native payments and exact-output trading are outside this
  package. The separate data client reads indexed bids; it never submits them.
- A market is identified by `(chainId, curve, marketId)`. Do not assume token
  symbols are identities or pick the first matching token across deployments.
- Native on-chain reads are `quoteBuy(id,amount,caller)` and
  `quoteSell(id,amount,caller)`, both `external view`. The SDK normalizes pairs;
  there is no newly deployed `quote(tokenIn,tokenOut,amountIn)` contract.
- Native swaps are `buy` and `sell`. Input is pulled from, and output is paid to,
  the immediate caller. An aggregator uses its executor as caller, then performs
  its usual final payout. No callback is invoked on the provider.
- **Rewards also use the immediate caller.** Direct wallets retain their buying
  reward identity. An intermediary is recorded for routed buys; the SDK cannot
  infer or authenticate its end user. Do not advertise end-user reward eligibility
  for generic aggregator routes. This is existing contract behavior, not an SDK fee.
- Approval is a separate transaction unless the provider already has an atomic
  funding mechanism. Confirm approvals and requote before submitting.
- Sell quotes returning a collateral component are rejected. Ordinary buys and
  sells, fees and reward accounting revert together on failure. A treasury transfer
  failure may defer treasury payment according to the existing fee contract.
- Buying can be paused while sells remain available. Propagate contract errors;
  do not report failed simulation as a successful trade.

## Networks And Trust

The bundled testnet manifest identifies the existing auction graph on chain
99801. The mainnet template intentionally fails validation until actual mainnet
values are supplied. Mainnet requires USDC and a fresh contract graph bound to
that token; changing an SDK address cannot change an immutable deployed binding.
There is no fallback between networks.

Contract hashes come from Oxley's release manifest. They authenticate a selected
deployment, not the economic authenticity of an arbitrary user-supplied manifest.
Oxley must supply the reviewed mainnet manifest. For proxy tokens such as USDC,
the proxy runtime hash is not proof that its implementation can never change.

The client verifies immutable contract pins on first use and on explicit
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
```

Local EVM tests use retained real Oxley creation bytecode and an unmodified 0x
BASIC implementation pinned in `test/contracts/upstream/provenance.json`. The
fixture wrapper supplies ordinary funding/final settlement, not the complete
0x Permit2/meta-transaction/deployment system. Tests and test compiler dependencies
are excluded from the npm archive. A source checkout includes reproduction scripts.
