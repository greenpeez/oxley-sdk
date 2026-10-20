import { parseAbi } from "viem";
export * from "./auction-abis.js";
export * from "./launch-abis.js";
export * from "./gen2-abis.js";

// The deployed VNext curve uses deal IDs, not token-pair selectors.
export const curveAbi = parseAbi([
  "function quoteAsset() view returns (address)",
  "function feeRouter() view returns (address)",
  "function lotRebate() view returns (address)",
  "function buysPaused() view returns (bool)",
  "function market(bytes32) view returns ((address coin,address creator,address reserveAsset,uint64 activatedAt,bool active,(uint8 segmentIndex,uint256 soldInSegment) position,uint256 priceOffsetWad,uint256 curveInventory,uint256 unburnedSupply,uint256 curveCapital))",
  "function quoteBuy(bytes32 dealId,uint256 grossQuoteIn,address buyer) view returns (uint256 coinOut,uint256 feeAmount)",
  "function quoteSell(bytes32 dealId,uint256 coinIn,address seller) view returns (uint256 quoteOut,uint256 collateralOut,uint256 feeAmount)",
  "function buy(bytes32 dealId,uint256 grossQuoteIn,uint256 minimumCoinOut,uint256 deadline) returns (uint256 coinOut)",
  "function sell(bytes32 dealId,uint256 coinIn,uint256 minimumQuoteOut,uint256 minimumCollateralOut,uint256 deadline) returns (uint256 quoteOut,uint256 collateralOut)",
  "event MarketActivated(bytes32 indexed dealId,address indexed coin,address indexed creator,address reserveAsset,uint256 quoteSeed)",
  "event Bought(bytes32 indexed dealId,address indexed buyer,uint256 grossQuoteIn,uint256 coinOut,uint256 feeAmount)",
  "event Sold(bytes32 indexed dealId,address indexed seller,uint256 coinIn,uint256 quoteOut,uint256 collateralOut,uint256 feeAmount)",
  "error Unauthorized()", "error InvalidConfiguration()", "error InvalidMarket()",
  "error DeadlineExpired()", "error MinimumNotMet()", "error StalePrice()",
  "error CapitalShortfall()", "error QuoteDust()", "error UnsupportedTokenBehavior()", "error BuysPaused()",
]);
export const registryAbi = parseAbi([
  "function deal(bytes32) view returns ((address creator,address coin,address controller,address reserveAsset,uint8 profile,uint8 status,uint64 createdAt,uint64 activatedAt,bytes32 profileDigest))",
]);
export const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
