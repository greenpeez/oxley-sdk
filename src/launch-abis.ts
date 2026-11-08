import { parseAbi } from "viem";

/**
 * Typed subsets of the Gen10 launch contracts, each tested against its full compiler ABI under `@oxley/sdk/abis/`:
 * `creator-account-factory.json`, `creator-account.json`, `auction-controller.json`, `entry-controller.json`, `bond-escrow.json` and `fee-router.json`.
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
  // Scheduled launches: anyone may execute from the start for 24 hours (the bond repays the caller's gas) and anyone may refund after the window.
  "function scheduleAuctionLaunch((string name,string symbol,uint256 floorPrice,uint8 lockDays,uint16 commitmentBps,uint8 requestedHours,uint32 durationBlocks) terms,uint64 startTime) payable",
  "function executeScheduledLaunch() returns (address token,bytes32 auctionId)",
  "function refundScheduledLaunch()",
  "function claimScheduledFee()",
  "function scheduledAuction() view returns (string name,string symbol,uint256 floorPrice,uint8 lockDays,uint16 commitmentBps,uint8 requestedHours,uint32 durationBlocks)",
  "function scheduledFeeOwed() view returns (uint256)",
  "function SCHEDULED_BOND() view returns (uint256)",
  "function MIN_LEAD() view returns (uint64)", "function MAX_LEAD() view returns (uint64)", "function EXECUTION_WINDOW() view returns (uint64)",
  "function MAX_NAME_BYTES() view returns (uint256)", "function MAX_SIMULATED_GAS() view returns (uint256)",
  // Creator claims: the unused bond goes to the original creator only; fees are delivered to a recorded beneficiary by anyone.
  "function claimBondRefund(address recipient) returns (bool paid)",
  "function claimFees(address recipient) returns (uint256 amount)",
  "function pendingFees(address recipient) view returns (uint256 amount)",
  "function feeCredits(address recipient) view returns (uint256 amount)",
  "function feeRouter() view returns (address)",
  "function handoverCount() view returns (uint256)",
  "function isValidPublicationSignature(bytes32 purpose,bytes32 payloadHash,uint256 epoch,uint64 deadline,bytes signature) view returns (bool)",
  "event AccountLaunched(bytes32 indexed dealId,address indexed coin,bool auction,bool listing)",
  "event AuctionListingCommitted(bytes32 indexed dealId,uint16 commitmentBps)",
  "event AuctionLaunchScheduled(bytes32 indexed dealId,address indexed creator,uint64 startTime,(string name,string symbol,uint256 floorPrice,uint8 lockDays,uint16 commitmentBps,uint8 requestedHours,uint32 durationBlocks) terms)",
  "event ScheduledLaunchRefunded(bytes32 indexed dealId)",
  "event BondRefundReceived(uint256 amount)", "event BondRefundPaid(address indexed recipient,uint256 amount)", "event CreatorFeesPaid(address indexed recipient,uint256 amount)",
  "error InvalidConfiguration()", "error Unauthorized()", "error TransferAmountMismatch()", "error InvalidTicker()", "error ReservedTicker(bytes32 canonicalKey)",
  "error GasPriceTooHigh()", "error NotLaunched()", "error FeesLocked()",
  "error ScheduledLaunchRefused(bytes reason)", "error ScheduledLaunchSimulated()", "error ScheduledLaunchTooExpensive(uint256 gasUsed)",
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
  "function tickerHold(bytes32 ticker) view returns (address account,uint64 until)",
  "function HOLD_COOLDOWN() view returns (uint256)",
  "event CcaDealSchedule(bytes32 indexed dealId,uint8 requestedHours,uint32 durationBlocks,uint64 targetEndTimestamp)",
  "event TickerHeld(address indexed account,bytes32 indexed ticker,uint64 until)",
]);
/** The entry controller pauses new launches. */
export const launchEntryAbi = parseAbi(["function entriesPaused() view returns (bool)"]);
/** The bond escrow: `CREATOR_DEPOSIT` is the native operating bond a launch carries, `MAX_GAS_PRICE` the highest gas price at which a launch is accepted. */
export const launchBondAbi = parseAbi([
  "function controller() view returns (address)",
  "function CREATOR_DEPOSIT() view returns (uint256)",
  "function MAX_GAS_PRICE() view returns (uint256)",
  "function SCHEDULED_LAUNCH_GAS() view returns (uint256)",
  "function availableBond(bytes32 dealId,address creator) view returns (uint256)",
  "function funds(bytes32 dealId,address creator) view returns (uint256 balance,uint256 nextRefundBid,uint256 bidCount,uint256 completedBids,uint8 outcome,bool funded,bool complete,address batcher)",
  "function credits(address recipient) view returns (uint256 amount)",
  "event BondReturned(bytes32 indexed dealId,address indexed creator,uint256 amount,bool successful)",
  "event ScheduledLaunchReimbursed(bytes32 indexed dealId,address indexed executor,uint256 amount)",
]);
/** The fee router the creator account collects its fees from. `dealConfig` carries the creator's lock (`creatorUnlockAt`) and whether the deal is active (its auction succeeded). */
export const creatorFeeRouterAbi = parseAbi([
  "function dealConfig(bytes32 id) view returns (address creator,uint64 lockDuration,uint64 creatorUnlockAt,bool active)",
  "function creatorClaimable(bytes32 id,address asset) view returns (uint256 amount)",
]);
