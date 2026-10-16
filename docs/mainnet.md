# Mainnet Inputs

The same SDK runs against the final USDC graph. RPC URLs stay outside the manifest
so providers can use their own infrastructure without distributing credentials.
The template is deliberately invalid while fields are missing; no guessed chain,
testnet fallbacks or fake deployment addresses are supplied.

| Field | Required value | Owner |
| --- | --- | --- |
| `releaseId` | Immutable Oxley mainnet release identifier | Oxley |
| `chainId` | Official Elysium mainnet chain ID, not `99801` | Elysium/Oxley |
| `startBlock` | Decimal block number of selected curve deployment | Oxley |
| `curve.address` | Verified USDC-bound ReserveCurveVNext-compatible contract | Oxley |
| `curve.runtimeCodeHash` | Keccak-256 of deployed runtime, including immutables | Oxley |
| `registry.address`, `runtimeCodeHash` | Mainnet auction registry and runtime identity | Oxley |
| `quoteToken.address`, `runtimeCodeHash` | Authoritative Elysium USDC contract/proxy and runtime | Elysium/Oxley |
| `quoteToken.decimals`, `symbol` | `6`, `USDC` | Fixed SDK requirement |
| `auctionController` | Controller registering this release's auction markets | Oxley |
| RPC transport | Working Elysium mainnet RPC endpoint | Oxley or provider |
| Source verification links | Mainnet verified curve and registry; token identity provenance | Oxley |
| Active market | Coin and market ID after successful auction settlement | Oxley/market creator |

## Auction And Data Bindings

Auction participation additionally requires `auctionBindings` from the reviewed
release: `controllerRuntimeCodeHash`, `bidRouter.address/runtimeCodeHash` and
`adapter.address/runtimeCodeHash`. Use `parseAuctionDeployment` and the auction
client to verify these alongside the controller, registry, token and on-chain
auction bindings. The trading template alone does not supply these extra pins.
See [auction integration](auctions.md). Mainnet auction execution needs its own
acceptance checks; funded swap tests do not prove bid/refund/claim behavior there.

Indexed data requires an explicitly enabled mainnet API deployment and approved
mainnet indexer, chain, release and USDC bindings. The existing public API serves
testnet only; changing a frontend's `chainId` cannot switch its data source to
mainnet. No mainnet endpoint or deployment address is promised by this package.

## Launch Validation

Validate the reviewed manifest using `parseDeployment`, then call
`verifyDeployment` over the actual mainnet RPC and discover the active market.
Exercise `quote` and `checkSwap` with the actual caller. For proxies, separately
verify implementation/admin provenance; unchanged proxy runtime does not pin its
implementation. Source acceptance and a funded smoke swap remain launch checks.

No new pricing engine, custom 0x signer policy, authenticated taker getter or SDK
rewrite is necessary for basic routing. If a later contract release changes an
ABI or economic behavior, give it a new SDK/deployment compatibility version.

Native HYPE remains operating gas paid by the relevant transaction submitter.
It is not an alternative bid/trade payment asset or an SDK sponsorship budget.
