/** The launch controller's floor cap: it reverts `FloorPriceAboveMaximum` above this floor, in the controller's `floorPriceWad` units. */
export const MAX_FLOOR_PRICE_WAD = 10n ** 21n;
/** Net minimum raise in USDC base units (6 decimals): $30,000. The controller reports it as `minimumRaise()`, an immutable set at deployment. */
export const MINIMUM_NET_RAISE = 30_000_000_000n;
const PLATFORM_FEE_BPS = 100n, BPS = 10_000n;
/**
 * The controller grosses the net minimum up for its 1% platform fee: `minimumGrossRaise() = mulDiv(net, 10_000, 9_900)`, rounded down
 * (30,303,030,303). `verifyDeployment` of the auctions client checks the pinned controller reports exactly these two figures.
 */
export const MINIMUM_GROSS_RAISE = MINIMUM_NET_RAISE * BPS / (BPS - PLATFORM_FEE_BPS);
