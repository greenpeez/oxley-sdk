# Mainnet Inputs

The SDK supports one contract release shape, Gen10, and mainnet is a fresh deployment of it on
Elysium mainnet, bound to that chain's USDC. `deployments/mainnet.template.json` has the same fields as
`deployments/elysium-testnet.json`. It is deliberately invalid until every placeholder is replaced, so
`parseDeployment` throws on it: no guessed chain, no testnet fallback and no fake address is supplied.
There is no fallback between networks. A mainnet manifest that names chain `99801` or the testnet
Oxy-USDC address is refused with `TESTNET_ON_MAINNET`, so testnet bindings cannot be used on mainnet.
RPC URLs stay outside the manifest, so a provider uses its own endpoint and credentials.

## What Oxley Supplies

Every `null` and `REPLACE_WITH_*` value in the template, all from the reviewed mainnet release:

| Field | Value |
| --- | --- |
| `releaseId`, `status` | Immutable release identifier and a non-empty release status |
| `chainId` | Official Elysium mainnet chain ID (a positive integer, not `99801`) |
| `startBlock` | Decimal-string block at which the graph exists; the SDK refuses earlier blocks |
| `curve`, `registry` | `address` and `runtimeCodeHash` of the mainnet curve and registry |
| `quoteToken` | `address` and `runtimeCodeHash` of the authoritative Elysium USDC contract |
| `auctionController` | Address of the controller that registers this release's auctions |
| `termsRegistry` | `address` and `runtimeCodeHash` of the terms registry the curve and hook enforce |
| `auctionBindings.controllerRuntimeCodeHash` | Runtime hash of the controller |
| `auctionBindings.bidRouter`, `adapter`, `bidHook`, `exposureHelper` | `address` and `runtimeCodeHash` of each |
| `launchBindings.creatorAccountFactory`, `entryController`, `bondEscrow` | `address` and `runtimeCodeHash` of each (creator accounts are deployed by the factory and have no pin of their own) |
| `launchBindings.launchFeeBaseUnits` | The controller's `launchFee()` in USDC base units, as a decimal string |

A runtime hash is the Keccak-256 of the deployed runtime code, including immutables. Fixed by the SDK and
already filled in: `schemaVersion` `1`, `network` `"mainnet"`, `quoteToken.symbol` `"USDC"` and
`decimals` `6`, `launchBindings.deployerBondWei` `"500000000000000000"` (the bond escrow's 0.5 native-asset
`CREATOR_DEPOSIT`, which the launch call carries), and `bidRules`, which must equal the compiled Dynamic Bid rules
exactly. The nine contract addresses of the auction graph must be distinct, and so must the twelve with the three launch contracts.
`launchBindings` are required only by the launch client (`createOxleyLaunchClient`); a trading or auction integration may leave them out, but when the key is present they are validated in full.

Outside the manifest: a working Elysium mainnet RPC endpoint, mainnet source-verification links for each
contract, the provenance of the token identity, and (once an auction succeeds) the coin and market ID.

## What The SDK Verifies

`parseDeployment` (offline): schema, positive chain ID, explicit network, decimal `startBlock`, an
address and 32-byte hash for every pin, distinct addresses, USDC with six decimals on mainnet, the
`TESTNET_ON_MAINNET` rule, the exact `bidRules` (`INVALID_BID_RULES`) and, when present, the launch bindings
(`LAUNCH_BINDINGS_REQUIRED`, `INVALID_LAUNCH_COST`, `INVALID_BOND`; the launch client alone refuses a manifest without them).

`verifyDeployment` on the trading client, at one block, ending with a canonical-block check (`REORG`):

- the RPC chain ID is the manifest's and the block is at or after `startBlock`;
- runtime code hash of the curve, registry, quote token and terms registry;
- the curve's quote asset is the manifest token, the token has 6 decimals, and the curve's terms registry is the manifest's.

`verifyDeployment` on the auction client, at one block, ending with the same canonical-block check:

- chain ID and `startBlock` as above; runtime code hash of the bid router, adapter, registry, quote token and controller;
- the controller names the pinned bid router, adapter, quote token and registry; the router names the adapter, the adapter names the controller, both name the quote token, and both name the same validation hook;
- the bid hook, exposure helper and terms registry hashes match, the hook is bound to the pinned router, terms registry and exposure helper, and the controller's terms registry is the pinned one;
- the hook's `MIN_BID_AMOUNT`, `TOKEN_CAP` and `MAX_PRICE_LEVELS` equal the compiled bid rules;
- the controller's `MAX_FLOOR_PRICE_WAD` is `1e21` (a controller without that getter fails the read), its `minimumRaise()` is 30,000 USDC (`30,000e6` base units) and its `minimumGrossRaise()` is `30,303,030,303`.

`verifyDeployment` on the launch client runs the auction client's checks, then at the same block: runtime code hash of the creator
account factory, entry controller and bond escrow; the controller names the pinned factory, entry controller and bond escrow, the
factory names the controller and escrow, and the escrow names the controller; `launchFee()` and `CREATOR_DEPOSIT()` equal the
manifest's costs (`LAUNCH_COST_MISMATCH`); and `durationBounds(1)` and `durationBounds(24)` are 14,400 to 72,000 blocks an hour
(`DURATION_BOUNDS_MISMATCH`).

Mismatches throw `CHAIN_MISMATCH`, `CODE_MISMATCH`, `QUOTE_BINDING_MISMATCH`, `TERMS_BINDING_MISMATCH` or
`AUCTION_BINDING_MISMATCH`. Each auction read also requires the deal to belong to this controller and
USDC (`UNSUPPORTED_AUCTION`). The bid rules, floor cap and minimum raise are constants of this SDK, not
manifest inputs: a mainnet release with other values needs a reviewed SDK update, not a manifest edit.

## Token And Launch Checks

For a proxy token such as USDC, the pinned proxy runtime hash fixes the proxy's code only. It is not proof
that the implementation or admin cannot change, so verify implementation and admin provenance separately.

Before launch, parse the reviewed manifest, run both clients' `verifyDeployment` over the actual mainnet
RPC, read the first auction with `getAuction` and a real wallet with `getDynamicBidLimits`, and exercise
`quote` and `checkSwap` with the actual caller once a market exists. Source acceptance and a funded smoke
transaction remain launch checks; nothing in this package substitutes for them.

Indexed data needs an explicitly enabled mainnet API deployment with approved indexer, chain, release and
USDC bindings. The public API serves testnet only, and changing a frontend's `chainId` cannot switch its data
source. See [data API](data-api.md) and [auction integration](auctions.md).
