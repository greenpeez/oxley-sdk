import { parseAbi } from "viem";

/** Typed integration subsets; full compiler ABIs are exported as JSON. */
export const auctionControllerAbi = parseAbi([
  "function feeBidRouter() view returns (address)",
  "function ccaAdapter() view returns (address)",
  "function quoteAsset() view returns (address)",
  "function registry() view returns (address)",
  "function campaign(bytes32) view returns (address creator,address coin,bytes32 auctionId,uint64 endBlock,bool open)",
  "function settle(bytes32 dealId)",
  "event CcaDealOpened(bytes32 indexed dealId,bytes32 indexed auctionId,address indexed coin,address creator,string name,string symbol,uint64 endBlock)",
  "event CcaDealFailed(bytes32 indexed dealId)",
]);
export const auctionBidRouterAbi = parseAbi([
  "function quoteAsset() view returns (address)",
  "function adapter() view returns (address)",
  "function validationHook() view returns (address)",
  "function quoteBid(uint128 entered) view returns (uint128 principal,uint256 debit,uint256 fee)",
  "function submitBid(bytes32 id,uint256 maxPrice,uint128 entered,uint256 previousTick,uint256 deadline) returns (uint256 bidId)",
  "event AcceptedBidFee(bytes32 indexed dealId,address indexed auction,address indexed owner,uint256 bidId,uint128 principal,uint256 fee,uint256 totalDebit)",
]);
export const auctionAdapterAbi = parseAbi([
  "function controller() view returns (address)",
  "function quoteAsset() view returns (address)",
  "function validationHook() view returns (address)",
  "function auctionFor(bytes32) view returns (address)",
  "function currentBlock() view returns (uint64)",
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
