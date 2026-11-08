import { parseAbi } from "viem";

/** Typed integration subsets. Every one is tested against the full compiler ABI of its contract, exported as JSON under `@oxley/sdk/abis/` (`auction-controller.json`, `adapter.json`, `bid-router.json`, `bid-hook.json`, `cca-auction.json`, ...). */
export const auctionControllerAbi = parseAbi([
  "function feeBidRouter() view returns (address)",
  "function ccaAdapter() view returns (address)",
  "function quoteAsset() view returns (address)",
  "function registry() view returns (address)",
  "function termsRegistry() view returns (address)",
  "function campaign(bytes32) view returns (address creator,address coin,bytes32 auctionId,uint64 endBlock,bool open)",
  "function settle(bytes32 dealId)",
  "event CcaDealOpened(bytes32 indexed dealId,bytes32 indexed auctionId,address indexed coin,address creator,string name,string symbol,uint64 endBlock)",
  "event CcaDealFailed(bytes32 indexed dealId)",
]);
/** The launch controller's floor cap: a fragment of `@oxley/sdk/abis/auction-controller.json`, checked against it. */
export const launchFloorCapAbi = parseAbi([
  "function MAX_FLOOR_PRICE_WAD() view returns (uint256)",
  "error FloorPriceAboveMaximum(uint256 floorPriceWad,uint256 maximum)",
]);
/**
 * The launch controller's minimum raise (an immutable set by the constructor): `minimumRaise()` is the net amount in USDC base units
 * ($30,000) and `minimumGrossRaise()` is that amount grossed up for the 1% platform fee. Also a checked fragment of the controller ABI.
 */
export const launchMinimumRaiseAbi = parseAbi([
  "function minimumRaise() view returns (uint256)",
  "function minimumGrossRaise() view returns (uint256)",
]);
/** Accepted-bid router: Dynamic Bids and one-transaction rebids; `data` is `abi.encode(BidWitness[])`. */
export const auctionBidRouterAbi = parseAbi([
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
/** Per-wallet admission hook. `preview` and `checkBid` checkpoint the auction first, so read them with `eth_call`. */
export const bidHookAbi = parseAbi([
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
/** The adapter creates the CCA from a launch; `MAX_CCA_BID_PRICE_Q96` is the highest price the pinned CCA accepts and `effectiveFloor` the launch floor it rounds to a tick. Full compiler ABI: `@oxley/sdk/abis/adapter.json`. */
export const auctionAdapterAbi = parseAbi([
  "function controller() view returns (address)",
  "function quoteAsset() view returns (address)",
  "function validationHook() view returns (address)",
  "function auctionFor(bytes32) view returns (address)",
  "function currentBlock() view returns (uint64)",
  "function MAX_CCA_BID_PRICE_Q96() view returns (uint256)",
]);
export const launchFloorAbi = parseAbi([
  "function effectiveFloor(uint256 floorPriceWad) pure returns (uint256 floorPriceQ96,uint256 tickSpacingQ96)",
]);
export const ccaAuctionAbi = parseAbi([
  "function token() view returns (address)",
  "function currency() view returns (address)",
  "function validationHook() view returns (address)",
  "function startBlock() view returns (uint64)",
  "function endBlock() view returns (uint64)",
  "function claimBlock() view returns (uint64)",
  "function floorPrice() view returns (uint256)",
  "function tickSpacing() view returns (uint256)",
  "function MAX_BID_PRICE() view returns (uint256)",
  "function isGraduated() view returns (bool)",
  "function bids(uint256 bidId) view returns ((uint64 startBlock,uint24 startCumulativeMps,uint64 exitedBlock,uint256 maxPrice,address owner,uint256 amountQ96,uint256 tokensFilled))",
  "function exitBid(uint256 bidId)",
  "function exitPartiallyFilledBid(uint256 bidId,uint64 lastFullyFilledCheckpointBlock,uint64 outbidBlock)",
  "function claimTokens(uint256 bidId)",
  "event BidSubmitted(uint256 indexed id,address indexed owner,uint256 priceQ96,uint128 amount)",
  "event BidExited(uint256 indexed bidId,address indexed owner,uint256 tokensFilled,uint256 currencyRefunded)",
  "event TokensClaimed(uint256 indexed bidId,address indexed owner,uint256 tokensFilled)",
]);
/** Continuous clearing auction reads the witnesses and tick walk need (all views except `checkpoint`). */
export const ccaCheckpointAbi = parseAbi([
  "function checkpoint() returns ((uint256 clearingPrice,uint256 currencyRaisedAtClearingPriceQ96X7,uint256 cumulativeMpsPerPrice,uint24 cumulativeMps,uint64 prev,uint64 next))",
  "function checkpoints(uint64 blockNumber) view returns ((uint256 clearingPrice,uint256 currencyRaisedAtClearingPriceQ96X7,uint256 cumulativeMpsPerPrice,uint24 cumulativeMps,uint64 prev,uint64 next))",
  "function lastCheckpointedBlock() view returns (uint64)",
  "function nextActiveTickPrice() view returns (uint256)",
  "function ticks(uint256 priceQ96) view returns ((uint256 next,uint256 currencyDemandQ96))",
  "event CheckpointUpdated(uint256 blockNumber,uint256 clearingPriceQ96,uint24 cumulativeMps)",
]);
/**
 * Rule errors decoded by `decodeOxleyRevert`: terms and curve trade errors, the Dynamic Bids hook and router, the launch controller's, creator account's,
 * bond escrow's and entry controller's launch errors, plus the CCA's wrapper around validation-hook reverts. The controller's `FloorPriceAboveMaximum`
 * is decoded from `launchFloorCapAbi`.
 */
export const oxleyRevertAbi = parseAbi([
  "error WalletCapExceeded(address owner,uint256 requested,uint256 remainingAllowance)",
  "error CreatorBidNotAllowed(address owner)",
  "error TradingNotOpen(bytes32 dealId,uint256 fallbackOpensAt)",
  "error ValidationHookCallFailed(bytes reason)",
  "error TermsNotAccepted(address user,uint64 requiredVersion,uint64 acceptedVersion)",
  "error BuysPaused()", "error MinimumNotMet()", "error DeadlineExpired()", "error QuoteDust()", "error CapitalShortfall()",
  "error WalletBidLimitReached(address owner,uint256 limit)", "error BidAmountTooLow()", "error PriceLevelLimit(uint256 maxPrice)",
  "error BidPriceTooHigh(uint256 submitted,uint256 maximum)", "error InvalidWitness()",
  "error BidExpired()", "error NotBidOwner()", "error BidNotOutbid()", "error RebidPriceTooLow(uint256 maxPrice,uint256 clearing)",
  "error TradeMoveLimit()",
  "error TickerUnavailable(string symbol)", "error InvalidTicker()", "error ReservedTicker(bytes32 canonicalKey)", "error InvalidListingCommitment()",
  "error InvalidDurationBlocks(uint32 durationBlocks,uint32 minimumBlocks,uint32 maximumBlocks)", "error InvalidRequestedHours(uint8 requestedHours)",
  "error FixtureLaunchOnly()", "error NewEntriesPaused()", "error GasPriceTooHigh()", "error NeedsFunding(uint256 balance,uint256 required)",
]);
