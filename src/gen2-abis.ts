import { parseAbi } from "viem";

/**
 * Gen2 typed integration subsets. Full compiler ABIs are exported under `@oxley/sdk/abis/gen2/*.json`.
 * Every flat-fee subset the SDK reads (controller, router, adapter, curve, creator account and factory)
 * is unchanged in Gen2; these add only the Gen2 entries.
 */
export const gen2CreatorAccountAbi = parseAbi([
  "function launchAuctionWithCommitmentAndExactDuration(string name,string symbol,uint256 floorPrice,uint8 lockDays,uint16 commitmentBps,uint8 requestedHours,uint32 durationBlocks) payable returns (address token,bytes32 auctionId)",
  "error ExactDurationRequired()",
]);
export const gen2AuctionControllerAbi = parseAbi([
  "function durationBounds(uint8 requestedHours) pure returns (uint32 minimumBlocks,uint32 maximumBlocks)",
  "function schedule(bytes32 dealId) view returns (uint8 requestedHours,uint32 durationBlocks,uint64 targetEndTimestamp)",
  "function minimumGrossRaise() view returns (uint256)",
  "function creatorControllerOf(address creator) view returns (address)",
  "event CcaDealSchedule(bytes32 indexed dealId,uint8 requestedHours,uint32 durationBlocks,uint64 targetEndTimestamp)",
  "error ExactDurationRequired()",
  "error InvalidRequestedHours(uint8 requestedHours)",
  "error InvalidDurationBlocks(uint32 durationBlocks,uint32 minimumBlocks,uint32 maximumBlocks)",
]);
/** Keyed by auction address (`adapter.auctionFor(dealId)`); amounts are bid principal, excluding the router fee. */
export const breadthBidHookAbi = parseAbi([
  "function bidRouter() view returns (address)",
  "function isRegistered(address auction) view returns (bool)",
  "function walletAllowance(address auction,address owner) view returns (uint256)",
  "function walletCap(address auction) view returns (uint256)",
  "function minimumGrossRaise(address auction) view returns (uint256)",
  "function counted(address auction) view returns (uint256)",
  "function breadthReached(address auction) view returns (bool)",
  "function committed(address auction,address owner) view returns (uint256 principal)",
  "function isExcludedBidder(address auction,address owner) view returns (bool)",
  "function checkBid(address auction,address owner,uint128 principal) view",
  "event BreadthReached(bytes32 indexed dealId,address indexed auction,uint256 counted)",
  "error WalletCapExceeded(address owner,uint256 requested,uint256 remainingAllowance)",
  "error CreatorBidNotAllowed(address owner)",
  "error AuctionNotRegistered(address auction)",
]);
export const gen2CurveAbi = parseAbi([
  "function tradingOpen(bytes32 dealId) view returns (bool)",
  "function tradingFallbackAt(bytes32 dealId) view returns (uint256)",
  "function GATE_FALLBACK() view returns (uint256)",
  "function settlementEscrow() view returns (address)",
  "error TradingNotOpen(bytes32 dealId,uint256 fallbackOpensAt)",
]);
/**
 * Rule errors decoded by `decodeOxleyRevert`: Gen2 launch/bid/gate rules, the Gen3/Gen8 terms and curve trade errors, the Gen8
 * Dynamic Bids hook and router, plus the CCA's wrapper around validation-hook reverts.
 */
export const oxleyRevertAbi = parseAbi([
  "error WalletCapExceeded(address owner,uint256 requested,uint256 remainingAllowance)",
  "error CreatorBidNotAllowed(address owner)",
  "error AuctionNotRegistered(address auction)",
  "error TradingNotOpen(bytes32 dealId,uint256 fallbackOpensAt)",
  "error ExactDurationRequired()",
  "error InvalidDurationBlocks(uint32 durationBlocks,uint32 minimumBlocks,uint32 maximumBlocks)",
  "error InvalidRequestedHours(uint8 requestedHours)",
  "error ValidationHookCallFailed(bytes reason)",
  "error TermsNotAccepted(address user,uint64 requiredVersion,uint64 acceptedVersion)",
  "error BuysPaused()", "error MinimumNotMet()", "error DeadlineExpired()", "error QuoteDust()", "error CapitalShortfall()",
  "error WalletBidLimitReached(address owner,uint256 limit)", "error BidAmountTooLow()", "error PriceLevelLimit(uint256 maxPrice)",
  "error BidPriceTooHigh(uint256 submitted,uint256 maximum)", "error InvalidWitness()",
  "error BidExpired()", "error NotBidOwner()", "error BidNotOutbid()", "error RebidPriceTooLow(uint256 maxPrice,uint256 clearing)",
]);
