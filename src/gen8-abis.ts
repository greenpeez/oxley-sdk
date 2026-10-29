import { parseAbi } from "viem";

/**
 * Gen8 typed integration subsets. Full compiler ABIs: `@oxley/sdk/abis/gen8/{curve,bid-router,bid-hook}.json`.
 * The Gen8 curve is quote-only: `market` has no reserve asset, quotes take no account argument and `sell` has four arguments.
 */
export const gen8CurveAbi = parseAbi([
  "function quoteAsset() view returns (address)",
  "function feeRouter() view returns (address)",
  "function termsRegistry() view returns (address)",
  "function buysPaused() view returns (bool)",
  "function market(bytes32) view returns ((address coin,address creator,uint64 activatedAt,bool active,(uint8 segmentIndex,uint256 soldInSegment) position,uint256 priceOffsetWad,uint256 curveInventory,uint256 curveCapital))",
  "function quoteBuy(bytes32 dealId,uint256 grossQuoteIn) view returns (uint256 coinOut,uint256 feeAmount)",
  "function quoteSell(bytes32 dealId,uint256 coinIn) view returns (uint256 quoteOut,uint256 feeAmount)",
  "function buy(bytes32 dealId,uint256 grossQuoteIn,uint256 minimumCoinOut,uint256 deadline) returns (uint256 coinOut)",
  "function sell(bytes32 dealId,uint256 coinIn,uint256 minimumQuoteOut,uint256 deadline) returns (uint256 quoteOut)",
  "error Unauthorized()", "error InvalidConfiguration()", "error InvalidMarket()", "error DeadlineExpired()",
  "error MinimumNotMet()", "error CapitalShortfall()", "error QuoteDust()", "error BuysPaused()",
  "error TradingNotOpen(bytes32 dealId,uint256 fallbackOpensAt)",
]);
/** Gen8 accepted-bid router: bids and one-transaction rebids; `data` is `abi.encode(BidWitness[])`. */
export const gen8BidRouterAbi = parseAbi([
  "function quoteAsset() view returns (address)",
  "function adapter() view returns (address)",
  "function validationHook() view returns (address)",
  "function quoteBid(uint128 entered) view returns (uint128 principal,uint256 debit,uint256 fee)",
  "function submitBid(bytes32 id,uint256 maxPrice,uint128 entered,uint256 previousTick,uint256 deadline,bytes data) returns (uint256)",
  "function rebid(bytes32 id,uint256 oldBidId,(uint64 lastFull,uint64 outbid) exit,uint256 maxPrice,uint128 entered,uint256 previousTick,uint256 deadline,bytes data) returns (uint256 bidId)",
  "event AcceptedBidFee(bytes32 indexed dealId,address indexed auction,address indexed owner,uint256 bidId,uint128 principal,uint256 fee,uint256 totalDebit)",
  "event Rebid(bytes32 indexed dealId,address indexed owner,uint256 oldBidId,uint256 bidId)",
  "error BidExpired()", "error NotBidOwner()", "error BidNotOutbid()", "error InvalidBinding()", "error TransferAmountMismatch()",
  "error RebidPriceTooLow(uint256 maxPrice,uint256 clearing)",
]);
/** Gen8 per-wallet admission hook. `preview` and `checkBid` checkpoint the auction first, so read them with `eth_call`. */
export const gen8BidHookAbi = parseAbi([
  "function bidRouter() view returns (address)",
  "function termsRegistry() view returns (address)",
  "function exposureHelper() view returns (address)",
  "function MIN_BID_AMOUNT() view returns (uint128)",
  "function TOKEN_CAP() view returns (uint256)",
  "function MAX_PRICE_LEVELS() view returns (uint256)",
  "function rules(address auction) view returns (uint256 minimum,address creator,address controller)",
  "function levels(address auction) view returns (uint256)",
  "function walletBids(address auction,address owner) view returns (uint256[])",
  "function walletBidsRemaining(address auction,address owner) view returns (uint256)",
  "function preview(address auction,address owner,(uint64 lastFull,uint64 outbid)[] witnesses) returns (uint256 committed,uint256 ceiling,uint256 allowance)",
  "function checkBid(address auction,address owner,uint256 price,uint128 amount,bytes data)",
  "error BidAmountTooLow()", "error BidPriceTooHigh(uint256 submitted,uint256 maximum)", "error CreatorBidNotAllowed(address owner)",
  "error InvalidBidOwner()", "error InvalidRegistration()", "error InvalidWitness()", "error PriceLevelLimit(uint256 maxPrice)",
  "error UnauthorizedBid()", "error WalletBidLimitReached(address owner,uint256 limit)",
  "error WalletCapExceeded(address owner,uint256 requested,uint256 remainingAllowance)",
]);
/** Continuous clearing auction reads the Gen8 witnesses and tick walk need (all views except `checkpoint`). */
export const ccaCheckpointAbi = parseAbi([
  "function checkpoint() returns ((uint256 clearingPrice,uint256 currencyRaisedAtClearingPriceQ96X7,uint256 cumulativeMpsPerPrice,uint24 cumulativeMps,uint64 prev,uint64 next))",
  "function checkpoints(uint64 blockNumber) view returns ((uint256 clearingPrice,uint256 currencyRaisedAtClearingPriceQ96X7,uint256 cumulativeMpsPerPrice,uint24 cumulativeMps,uint64 prev,uint64 next))",
  "function lastCheckpointedBlock() view returns (uint64)",
  "function nextActiveTickPrice() view returns (uint256)",
  "function ticks(uint256 priceQ96) view returns ((uint256 next,uint256 currencyDemandQ96))",
  "event CheckpointUpdated(uint256 blockNumber,uint256 clearingPriceQ96,uint24 cumulativeMps)",
]);
/** Gen8 adapter: the highest price the pinned CCA accepts. */
export const gen8AdapterAbi = parseAbi(["function MAX_CCA_BID_PRICE_Q96() view returns (uint256)"]);
