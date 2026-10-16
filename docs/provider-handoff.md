# Provider Handoff

Oxley's post-auction markets support USDC/token swaps with on-chain view quotes
and immediate atomic settlement. The attached SDK is optional: the ABI and
Solidity interface are sufficient for a provider's own integration.

## Send Now

| Material | Included location |
| --- | --- |
| Installable JavaScript and TypeScript types | `@oxley/sdk@0.5.0-next.2`, on the `next` release line |
| Full curve and registry ABI JSON | `abis/` |
| Auction controller, bid router, adapter and CCA ABI JSON | `abis/`, see [auction guide](auctions.md) |
| Unsigned bid, claim and full/partial refund helpers | `@oxley/sdk/auctions`, `examples/auction.ts` |
| Minimal Solidity integration interface | `docs/IOxleyCurve.sol` |
| Network, token, addresses and runtime pins | `deployments/elysium-testnet.json` |
| Quote, approvals and calldata usage | `README.md`, `examples/` |
| 0x optional source action and exact offsets | `docs/0x.md`, `@oxley/sdk/0x` |
| Runtime and settlement test evidence | `docs/validation.md` |
| Mainnet profile template and ownership | `deployments/mainnet.template.json`, `docs/mainnet.md` |

## Current Testnet Bindings

| Field | Value |
| --- | --- |
| Network | Elysium testnet |
| Chain ID | `99801` |
| Public RPC | `https://testnet-rpc.elysium.kinetiq.xyz` |
| Curve; swap target and direct allowance spender | `0x18bf92514c0d749a017aaf69153442703e1a966b` |
| Market registry | `0x6acc92ba104446facd7aebe113f907b1d0874d0b` |
| Auction controller | `0xeece6d3985e32dcd0d59c8a95b4a2bef745f506d` |
| Oxy-USDC, six decimals | `0xa4ce6e6c719f7fb524230c367948039b078683e4` |
| Curve deployment block | `5451974` |
| Explorer | [Elysium testnet explorer](https://elysium.kinetiq.xyz/testnet-explorer) |
| Curve verification page | [Curve source and ABI](https://elysium.kinetiq.xyz/testnet-explorer/address/0x18bf92514c0d749a017aaf69153442703e1a966b?tab=contract) |

These are **testnet** addresses. Do not ship them as mainnet bindings. The runtime
pins match the retained release evidence and the fresh public RPC check. Explorer
source verification is not an independent security audit or proof of mainnet readiness.

## Discovery And Execution

Watch `MarketActivated(bytes32,address,address,address,uint256)` on the curve,
starting at its deployment block. Reconcile `registry.deal(id)` and
`curve.market(id)` at a single block: profile `Cca = 1`, status `Active = 3`,
authorized auction controller, matching coin/creator and quote asset, active curve.
The SDK performs these checks and returns resumable block/hash cursors. A token
pair can have multiple market identities; preserve the market ID explicitly.

Use `quoteBuy` for USDC to coin and `quoteSell` for coin to USDC. The returned
output is net of fees; do not subtract fees again. Ordinary trading fee is 2%,
but always use the contract quote for exact rounding and actual caller behavior.
Quotes requiring collateral output are not supported by this integration.

Call `buy` or `sell` on the curve with exact input, minimum output and deadline.
Input approval and balance belong to the immediate caller, as do output and
buying-reward identity. A provider's executor can fund, swap and pay its recipient
in its existing transaction. There is no Oxley callback or private API handshake.

## Still Required For Live Mainnet Routing

Oxley supplies the final reviewed mainnet manifest, real USDC-bound deployment,
verification links, deployment block and at least one active market when Elysium
mainnet is available. The provider installs its normal DEX source integration and
enables it in its routing engine. Those operational steps cannot be completed by
shipping an SDK alone. No provider-specific contract extension is requested.

## Frontend Data Builders

The separate `@oxley/sdk/data` client in `0.5.0-next.1` covers indexed auctions,
wallet bids for a specified auction, recent auction events, trades, volume and candles.
See [the data API guide](data-api.md) and [polling example](../examples/live-data.ts).
Use `https://app.oxley.fun/api/data/v1` with chain ID `99801` and `model: 'cca'`.
The current feeds are Elysium testnet/Oxy-USDC, without an API key or wallet.
This display-data integration is distinct from aggregator execution or exchange
token-listing, deposit/withdrawal, custody and confirmation-policy integrations.

## Auction Participation

Version `0.5.0-next.2` adds runtime-verified auction transaction preparation.
Bids approve and call the fee-aware bid router. Token claims and principal refunds
call the actual CCA auction, not its launch controller. Partial fills use explicit
checkpoint hints. All outputs are unsigned; providers retain signing and submission.
An executor submitting a bid becomes its owner, unlike swaps where a provider can
forward an immediately received output. See [auction integration](auctions.md)
before composing a bid through a shared executor. This is not an instant-settlement
DEX route and does not introduce custody, deposit or withdrawal services.
