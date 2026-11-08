import { parseAbi } from "viem";

/** The curve is quote-only: `market` has no reserve asset (it carries the launch-scaled `priceScaleWad`), quotes take no account argument and `sell` has four arguments. Full compiler ABI: `@oxley/sdk/abis/curve.json`. */
export const curveAbi = parseAbi([
  "function quoteAsset() view returns (address)",
  "function feeRouter() view returns (address)",
  "function termsRegistry() view returns (address)",
  "function buysPaused() view returns (bool)",
  "function market(bytes32) view returns ((address coin,address creator,uint64 activatedAt,bool active,(uint8 segmentIndex,uint256 soldInSegment) position,uint256 priceOffsetWad,uint256 priceScaleWad,uint256 curveInventory,uint256 curveCapital))",
  "function quoteBuy(bytes32 dealId,uint256 grossQuoteIn) view returns (uint256 coinOut,uint256 feeAmount)",
  "function quoteSell(bytes32 dealId,uint256 coinIn) view returns (uint256 quoteOut,uint256 feeAmount)",
  "function buy(bytes32 dealId,uint256 grossQuoteIn,uint256 minimumCoinOut,uint256 deadline) returns (uint256 coinOut)",
  "function sell(bytes32 dealId,uint256 coinIn,uint256 minimumQuoteOut,uint256 deadline) returns (uint256 quoteOut)",
  "event MarketActivated(bytes32 indexed dealId,address indexed coin,address indexed creator,uint256 quoteSeed)",
  "error Unauthorized()", "error InvalidConfiguration()", "error InvalidMarket()", "error DeadlineExpired()",
  "error MinimumNotMet()", "error CapitalShortfall()", "error QuoteDust()", "error BuysPaused()", "error TradeMoveLimit()",
  "error TradingNotOpen(bytes32 dealId,uint256 fallbackOpensAt)",
]);
/** The curve stays closed until settlement delivery completes or its timed fallback passes. */
export const tradingGateAbi = parseAbi([
  "function tradingOpen(bytes32 dealId) view returns (bool)",
  "function tradingFallbackAt(bytes32 dealId) view returns (uint256)",
  "function GATE_FALLBACK() view returns (uint256)",
  "function settlementEscrow() view returns (address)",
]);
/** The decaying opening surcharge on buys. */
export const openingFeeCurveAbi = parseAbi([
  "function openingSurchargeWad(bytes32 dealId) view returns (uint256)",
  "function currentBuyFeeBps(bytes32 dealId) view returns (uint256)",
  "function surchargeWadAt(uint256 elapsed) pure returns (uint256)",
  "function STANDARD_TRADING_FEE_BPS() view returns (uint256)",
  "function MINIMUM_BUY_USDC_UNITS() view returns (uint256)",
]);
/** End-user terms the curve and the Dynamic Bids hook enforce. Full compiler ABI: `@oxley/sdk/abis/terms-registry.json`. */
export const termsRegistryAbi = parseAbi([
  "function latestVersion() view returns (uint64)",
  "function requiredVersion() view returns (uint64)",
  "function acceptedVersion(address user) view returns (uint64)",
  "function hasAccepted(address user) view returns (bool)",
  "function terms(uint64 version) view returns ((bytes32 termsHash,uint64 publishedAt,string uri))",
  "function acceptTerms(uint64 version,bytes32 termsHash)",
  "event TermsAccepted(address indexed user,uint64 indexed version,bytes32 termsHash,address indexed submitter)",
  "error TermsNotAccepted(address user,uint64 requiredVersion,uint64 acceptedVersion)",
  "error UnknownVersion(uint64 version)",
  "error TermsHashMismatch(uint64 version,bytes32 expected,bytes32 provided)",
  "error AlreadyAccepted(address user,uint64 acceptedVersion)",
]);
