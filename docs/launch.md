# Launch Floors

`@oxley/sdk/launch` holds the **pure launch-floor rules**: given the floor price a creator
wants, it tells a form or an agent whether the launch controller will accept it and what the
auction will actually use. It reads nothing from a chain and needs no wallet.

The SDK does **not** prepare launch transactions: no creator account, launch-fee approval or
native operating bond. Launch an auction from the Oxley app (`https://app.oxley.fun`). Bidding
on and settling a launched auction is in [auctions](auctions.md).

## Floor Scale

Despite the contract's `floorPriceWad` name, the deployed six-decimal USDC / eighteen-decimal
coin adapter reads **24 decimal places for a human USDC-per-coin price**. For example
`parseUnits('0.00001', 24)` is `10000000000000000000n`, not an eighteen-decimal conversion.
The curve's own lowest floor is `9_959_120_000_000_000_000n` (about $0.00000996); the
controller reverts `FloorPriceAboveMaximum` above `MAX_FLOOR_PRICE_WAD` = 1e21 ($0.001 a
coin). The adapter rounds the floor **up** to a tick, so show the effective price
(`quoteAuctionFloor(...).effectiveFloorPriceWad`), not just the input.

## The Minimum-Raise Rule

Every auction offers `OFFERED_UNITS` = 300,000,000 coins. The bid hook registers an auction
only if `floorPriceQ96 x 300,000,000 coins >= ceil(minimumGrossRaise / 10) x 10 x 2^96`
(`floorPriceQ96` is what `quoteAuctionFloor` returns). A launch with a lower floor reverts. The
controller's figures are fixed at deployment and checked by the auctions client's
`verifyDeployment`:

| | Value |
| --- | --- |
| Net minimum raise (`minimumRaise()`, `MINIMUM_NET_RAISE`) | $30,000 (30,000,000,000 base units) |
| Gross minimum (`minimumGrossRaise()`, `MINIMUM_GROSS_RAISE`) | 30,303,030,303: net x 10,000 / 9,900, rounded down, for the 1% platform fee |
| Lowest floor (`minimumRaiseFloor()`) | 101,010,101,030,162,826,490, about $0.00010101 a coin |
| Highest floor (`MAX_FLOOR_PRICE_WAD`) | 1,000,000,000,000,000,000,000 ($0.001 a coin) |
| Opening per-wallet bid ceiling (`ceil(gross / 10)`) | $3,030.303031 |

A form that shows four significant digits should round the lowest floor up, `$0.0001011`, so
the number shown can be typed and passes. All amounts are USDC (Oxy-USDC on testnet).

## Functions

- `quoteAuctionFloor(floorPriceWad)` mirrors the adapter: returns `{ floorPriceQ96,
  tickSpacingQ96, effectiveFloorPriceWad }` and throws `INVALID_FLOOR` for a floor the adapter
  itself refuses (under the curve's minimum, or outside the CCA's bounds).
- `floorReachesMinimumRaise(floorPriceWad)` is the rule above, as a boolean.
- `minimumRaiseFloor()` is the exact lowest floor that passes.
- `validateLaunchFloor(floorPriceWad)` throws `FLOOR_ABOVE_MAXIMUM` above 1e21,
  `FLOOR_BELOW_MINIMUM_RAISE` below the lowest floor, or `INVALID_FLOOR` from
  `quoteAuctionFloor`.
- `OFFERED_UNITS` (300,000,000 coins in 18-decimal base units) is exported here only;
  `MAX_FLOOR_PRICE_WAD`, `MINIMUM_NET_RAISE` and `MINIMUM_GROSS_RAISE` also from the root and
  from `/auctions`.
- `launchFloorAbi` (the adapter's `effectiveFloor`), `launchFloorCapAbi` and
  `launchMinimumRaiseAbi` (the controller's cap and minimum-raise views) are typed fragments
  for cross-checking these figures on chain.
- `decodeOxleyRevert(errorOrData, { quoteSymbol? })` decodes the controller's
  `FloorPriceAboveMaximum` revert, and the other trading and bid reverts, into short messages.

```ts
import { parseUnits } from 'viem';
import { minimumRaiseFloor, quoteAuctionFloor, validateLaunchFloor } from '@oxley/sdk/launch';

const floorPriceWad = parseUnits('0.00015', 24); // 24 decimals for a human USDC-per-coin price
validateLaunchFloor(floorPriceWad);              // throws FLOOR_BELOW_MINIMUM_RAISE, FLOOR_ABOVE_MAXIMUM or INVALID_FLOOR
const { effectiveFloorPriceWad } = quoteAuctionFloor(floorPriceWad);
const lowest = minimumRaiseFloor();
```

See the typechecked [example](../examples/launch-floor.ts). Off-chain editable metadata
(images, descriptions, links) is a separate workflow that this package does not publish.
