# Provider Handoff

Oxley's post-auction markets support USDC/coin swaps with on-chain view quotes and immediate
atomic settlement. The attached SDK is optional: the ABI and Solidity interface are sufficient
for a provider's own integration.

Public links: [GitHub](https://github.com/greenpeez/oxley-sdk),
[npm](https://www.npmjs.com/package/@oxley/sdk), and
[Builders docs](https://oxley.fun/docs/builders).

## Send Now

| Material | Included location |
| --- | --- |
| Installable JavaScript and TypeScript types | `@oxley/sdk` |
| Full compiler ABI JSON of every Oxley contract the SDK touches, and the vendor CCA | `abis/`, see [auction guide](auctions.md) and [validation](validation.md) |
| Minimal Solidity integration interface | `docs/IOxleyCurve.sol` |
| Network, token, addresses and runtime pins | `deployments/elysium-testnet.json` |
| Quotes, swaps, terms, trading gate, opening surcharge | [markets](markets.md), `examples/quote-and-swap.ts` |
| Fee-bearing swaps for wallets and apps (EIP-5792 batch) | [integrator fees](integrator-fees.md), `examples/integrator-fee.ts` |
| 0x optional source action and exact offsets | [0x guide](0x.md), `@oxley/sdk/0x`, `examples/zero-ex.ts` |
| Unsigned Dynamic Bid, rebid, exit and claim helpers | `@oxley/sdk/auctions`, `examples/auction.ts`, `examples/dynamic-bid.ts` |
| Unsigned, simulated launch steps and the launch-floor rules | `@oxley/sdk/launch`, [launch](launch.md), `examples/launch.ts`, `examples/launch-floor.ts` |
| Scheduled launches, the unused bond, creator fees, and the creator's signed token details and image | `@oxley/sdk/launch`, `@oxley/sdk/metadata`, [creator](creator.md), `examples/scheduled-launch.ts`, `examples/creator.ts`, `examples/token-metadata.ts` |
| Public indexed auctions, bids, trades, volume and candles | `@oxley/sdk/data`, [data API](data-api.md), `examples/live-data.ts` |
| Runtime and settlement test evidence | [validation](validation.md) |
| Mainnet profile template and ownership | `deployments/mainnet.template.json`, [mainnet](mainnet.md) |

## Current Testnet Bindings

| Field | Value |
| --- | --- |
| Release | `elysium-auctions-gen10-1fa4ef2a98fd14ed` |
| Network | Elysium testnet |
| Chain ID | `99801` |
| Public RPC | `https://testnet-rpc.elysium.kinetiq.xyz` |
| Curve; swap target and direct allowance spender | `0x68926b5e1b479c1ba32fe8e87699dfe5cfe7bd91` |
| Market registry | `0x1e59df61e52f494492cf38ca6ae49a2eba259e13` |
| Auction controller | `0xff729e724c54045d04846cde960c3c5ad5e892fd` |
| Terms registry | `0x94c8c7203e2a01e37f104fa6cbe00382642c084d` |
| Oxy-USDC, six decimals | `0xa4ce6e6c719f7fb524230c367948039b078683e4` |
| Bid router | `0x74f01484ff135fe25dc1c942eb31da8d43e43d76` |
| Auction adapter | `0xedf70a600a700b6c6fa7a4defa96f23462b69565` |
| Bid hook | `0x86f87064955204e52ad3925c9412b3a5cd07e061` |
| Exposure helper | `0xddfc022e77664c806963040810904a1aa5e2ca46` |
| Deployment start block | `25237151` |
| Explorer | [Elysium testnet explorer](https://elysium.kinetiq.xyz/testnet-explorer) |

These are **testnet** addresses. Do not ship them as mainnet bindings. The manifest pins every
contract by runtime code hash. Explorer source verification is not an independent security
audit or proof of mainnet readiness.

## Discovery And Execution

Watch `MarketActivated(bytes32 indexed dealId, address indexed coin, address indexed creator,
uint256 quoteSeed)` on the curve, starting at its start block. Reconcile `registry.deal(id)`
and `curve.market(id)` at a single block: profile `Cca = 1`, status `Active = 3`, the
deployment's auction controller, matching coin and creator, USDC as the reserve asset, active
curve. The SDK performs these checks and returns resumable block/hash cursors. A token pair
can have multiple market identities; preserve the market ID explicitly.

Use `quoteBuy(id, amountIn)` for USDC to coin and `quoteSell(id, amountIn)` for coin to USDC.
Neither takes an account, and neither needs balance or allowance. The returned output is net of
fees; do not subtract fees again. The ordinary trading fee is 2%, and buys also pay a decaying
opening surcharge (18% at the opening, zero from 60 seconds), but always use the contract quote
for exact rounding.

Call `buy(id, amountIn, minAmountOut, deadline)` or `sell(id, amountIn, minAmountOut,
deadline)` on the curve with exact input, minimum output and deadline. Input approval,
balance, terms acceptance (once the registry enforces them) and output belong to the immediate
caller; a provider's executor can fund, swap and pay its recipient in its existing transaction.
The curve stays closed after settlement until every bid is delivered or its timed fallback
passes (`tradingOpen(id)`, `tradingFallbackAt(id)`). There is no Oxley callback or private API
handshake.

Read quotes through the provider's own RPC and compute the minimum locally with `prepareSwap` or
`minimumAmountOut`. Do not use indexed feeds or backend-supplied minimums as signing
authority. Confirm approvals, requote and simulate before submission; preserve transaction
hashes and unknown outcomes before retrying.

## Still Required For Live Mainnet Routing

Oxley supplies the final reviewed mainnet manifest, real USDC-bound deployment, verification
links, deployment block and at least one active market when Elysium mainnet is available. The
provider installs its normal DEX source integration and enables it in its routing engine.
Those operational steps cannot be completed by shipping an SDK alone. No provider-specific
contract extension is requested.

## Frontend Data Builders

The separate `@oxley/sdk/data` client covers indexed auctions, wallet bids for a specified
auction, recent auction events, trades, volume and candles. See [the data API
guide](data-api.md) and [polling example](../examples/live-data.ts). Use
`https://app.oxley.fun/api/data/v1` with chain ID `99801` and `model: 'cca'`. The current feeds
are Elysium testnet/Oxy-USDC, without an API key or wallet. This display-data integration is
distinct from aggregator execution or exchange token-listing, deposit/withdrawal, custody and
confirmation-policy integrations.

## Exchanges

Use the trading SDK for on-chain execution, the auction client for participation, or the data
client for market displays. An exchange's token listing, custody, deposit-crediting,
withdrawal signing, confirmations/reorg handling and compliance remain its own integration.
This SDK is not an exchange deposit or custody API. Use chain ID plus contract address/market
ID as identity, not a ticker. Mainnet support must wait for the reviewed real-USDC graph and
the exchange's acceptance checks; testnet output is not a mainnet settlement guarantee.

## Auction Participation

Bids are Dynamic Bids through the accepted-bid router, which charges a 0.1% fee on top of the
principal and carries per-wallet checkpoint witnesses for the bid hook; a rebid exits one
outbid bid and bids again. Token claims and principal refunds call the actual CCA auction, not
its launch controller, and partial fills use explicit checkpoint hints. All outputs are
unsigned; providers retain signing and submission. An executor submitting a bid becomes its
owner, unlike swaps where a provider can forward an immediately received output. See [auction
integration](auctions.md) before composing a bid through a shared executor. This is not an
instant-settlement DEX route and does not introduce custody, deposit or withdrawal services.
Launching an auction is prepared by `@oxley/sdk/launch` as unsigned, simulated steps ([launch](launch.md)); the creator pays the
launch fee in USDC and, in native HYPE, the launch's 0.5 operating bond and gas. A scheduled launch takes the same fee and bond when it is scheduled, and anyone (an aggregator's
executor included) may execute it from its start or refund it after its window ([creator](creator.md)).
