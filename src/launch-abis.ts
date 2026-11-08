import { parseAbi } from "viem";

/**
 * Typed subsets of the Gen10 launch contracts, each tested against its full compiler ABI under `@oxley/sdk/abis/`:
 * `creator-account-factory.json`, `creator-account.json`, `auction-controller.json`, `entry-controller.json` and `bond-escrow.json`.
 */
export const creatorAccountFactoryAbi = parseAbi([
  "function createAccountForDraft(bytes32 draftSalt,address beneficiary) returns (address account)",
  "function accountFor(address creator,bytes32 dealId) view returns (address)",
  "function isAccount(address account) view returns (bool)",
  "function auctionController() view returns (address)",
  "function bondEscrow() view returns (address)",
  "event CreatorAccountCreated(bytes32 indexed dealId,address indexed account,address indexed controller,address beneficiary)",
  "error AccountAlreadyExists()", "error InvalidConfiguration()",
]);
/**
 * The single-launch creator account. It pulls the launch fee from the caller (so the caller approves the account, not the controller), forwards the
 * native `msg.value` to the controller as the creator's operating bond, and keeps fee accounting and the unused-bond refund for its creator.
 */
export const creatorAccountAbi = parseAbi([
  "function launchAuctionWithCommitmentAndExactDuration(string name,string symbol,uint256 floorPrice,uint8 lockDays,uint16 commitmentBps,uint8 requestedHours,uint32 durationBlocks) payable returns (address token,bytes32 auctionId)",
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
  "function scheduledStart() view returns (uint64)",
  "function bondRefundBalance() view returns (uint256)",
  "event AccountLaunched(bytes32 indexed dealId,address indexed coin,bool auction,bool listing)",
  "event AuctionListingCommitted(bytes32 indexed dealId,uint16 commitmentBps)",
  "error InvalidConfiguration()", "error Unauthorized()", "error TransferAmountMismatch()", "error InvalidTicker()", "error ReservedTicker(bytes32 canonicalKey)",
]);
/** What the launch controller offers a launch: its bindings, the fee, ticker availability, the deal identity and the exact-duration bounds and record. */
export const launchControllerAbi = parseAbi([
  "function publicLaunchEnabled() view returns (bool)",
  "function creatorAccountFactory() view returns (address)",
  "function entryController() view returns (address)",
  "function bondEscrow() view returns (address)",
  "function launchFee() view returns (uint256)",
  "function isTickerAvailable(string symbol) view returns (bool)",
  "function dealIdFor(address creator,bytes32 draftSalt) view returns (bytes32)",
  "function durationBounds(uint8 requestedHours) pure returns (uint32 minimumBlocks,uint32 maximumBlocks)",
  "function schedule(bytes32 dealId) view returns (uint8 requestedHours,uint32 durationBlocks,uint64 targetEndTimestamp)",
  "event CcaDealSchedule(bytes32 indexed dealId,uint8 requestedHours,uint32 durationBlocks,uint64 targetEndTimestamp)",
]);
/** The entry controller pauses new launches. */
export const launchEntryAbi = parseAbi(["function entriesPaused() view returns (bool)"]);
/** The bond escrow: `CREATOR_DEPOSIT` is the native operating bond a launch carries, `MAX_GAS_PRICE` the highest gas price at which a launch is accepted. */
export const launchBondAbi = parseAbi([
  "function controller() view returns (address)",
  "function CREATOR_DEPOSIT() view returns (uint256)",
  "function MAX_GAS_PRICE() view returns (uint256)",
  "function availableBond(bytes32 dealId,address creator) view returns (uint256)",
]);
