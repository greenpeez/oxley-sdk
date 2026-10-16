import { parseAbi } from "viem";

export const creatorAccountFactoryAbi = parseAbi([
  "function createAccount(bytes32 dealId,address beneficiary) returns (address account)",
  "function accountFor(address,bytes32) view returns (address)",
  "function isAccount(address) view returns (bool)",
  "function auctionController() view returns (address)",
  "function bondEscrow() view returns (address)",
  "event CreatorAccountCreated(bytes32 indexed dealId,address indexed account,address indexed controller,address beneficiary)",
]);
export const creatorAccountAbi = parseAbi([
  "function launchAuctionWithCommitmentAndDuration(string name,string symbol,uint256 floorPrice,uint8 lockDays,uint16 commitmentBps,uint8 durationHours) payable returns (address token,bytes32 auctionId)",
  "function controller() view returns (address)",
  "function initialController() view returns (address)",
  "function beneficiary() view returns (address)",
  "function bondBeneficiary() view returns (address)",
  "function dealId() view returns (bytes32)",
  "function auctionController() view returns (address)",
  "function quoteAsset() view returns (address)",
  "function bondEscrow() view returns (address)",
  "function launched() view returns (bool)",
  "function coin() view returns (address)",
  "event AccountLaunched(bytes32 indexed dealId,address indexed coin,bool auction,bool listing)",
  "event AuctionListingCommitted(bytes32 indexed dealId,uint16 commitmentBps)",
]);
export const launchControllerAbi = parseAbi([
  "function publicLaunchEnabled() view returns (bool)",
  "function creatorAccountFactory() view returns (address)",
  "function entryController() view returns (address)",
  "function bondEscrow() view returns (address)",
  "function launchFee() view returns (uint256)",
  "function isTickerAvailable(string) view returns (bool)",
]);
export const launchEntryAbi = parseAbi(["function entriesPaused() view returns (bool)"]);
export const launchBondAbi = parseAbi([
  "function controller() view returns (address)",
  "function CREATOR_DEPOSIT() view returns (uint256)",
  "function MAX_GAS_PRICE() view returns (uint256)",
]);
export const launchFloorAbi = parseAbi([
  "function effectiveFloor(uint256 floorPriceWad) pure returns (uint256 floorPriceQ96,uint256 tickSpacingQ96)",
]);
