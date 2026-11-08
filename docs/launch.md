# Launching An Auction

`@oxley/sdk/launch` prepares the whole Gen10 launch as **unsigned, simulated transactions**, one step at a
time, and reads the result back from chain. Builders and AI agents need an independently configured
Elysium RPC and their own wallet: no Oxley backend, API key or signer is involved, and the SDK never
signs or broadcasts. The same module holds the pure [launch-floor rules](#launch-floor-rules).

## What A Launch Costs

| Cost | Asset | Amount | Where it goes |
| --- | --- | --- | --- |
| Launch fee | USDC (Oxy-USDC on testnet) | 1.5 (`1500000` base units) | Pulled from the owner by the creator account, which hands it to the controller at launch |
| Operating bond | Native HYPE | 0.5 (`500000000000000000` wei) | The `value` of the launch transaction; held by the bond escrow |
| Gas | Native HYPE | the gas of each step | Paid by the owner's wallet like any transaction |

USDC is the quote and payment asset: the launch fee, bids and trades are all in USDC. HYPE is the
chain's native gas token, and the auction deployer pays its operating costs, separately from anything
bid on a coin. The 0.5 HYPE bond and the gas are what the contracts require of the creator's wallet:
the SDK does not sponsor them, convert USDC into HYPE, or offer HYPE as a fee, bid or trade asset.

The bond funds the auction's own operations: the bond escrow repays the gas of delivery and refund
transactions from it, at a gas price of at most 1 gwei (`MAX_GAS_PRICE`). Unused bond comes back through
the escrow to the creator account, and only the original creator wallet can pay it out, with the account's
`claimBondRefund(recipient)`. The escrow's and the account's rules decide when and how much comes back: the SDK
neither promises a full refund nor prepares the claim, which is an ordinary call on the creator account
(`abis/creator-account.json`). `getLaunch` reports the bond the escrow still holds (`launch.bondHeld`) and the
refund the account has received (`bondRefundable`).

## Connect And Prepare

```ts
import { createPublicClient, http, parseUnits } from 'viem';
import { testnetDeployment } from '@oxley/sdk';
import { createOxleyLaunchClient, newDraftSalt } from '@oxley/sdk/launch';

const launches = createOxleyLaunchClient({
  deployment: testnetDeployment,
  publicClient: createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') }),
});
// Generate the salt ONCE and persist it with these terms. Reuse the same owner, salt and terms after
// reloads, timeouts and retries: the deal id and the creator account derive from them.
const intent = {
  owner: '0xYOUR_CREATOR_WALLET',
  draftSalt: newDraftSalt(),
  name: 'Example Coin',
  symbol: 'EXAMPLE',
  floorPriceWad: parseUnits('0.00015', 24), // 24 decimals for a human USDC-per-coin price
  creatorLockDays: 30,
  listingCommitmentBps: 5000,
  auctionDurationHours: 6,
} as const;

const step = await launches.prepareLaunch(intent);
if (step.stage === 'complete') {
  console.log(step.creatorAccount, step.launch?.coin, step.launch?.auction);
} else {
  // Review step.stage, step.stages (what is still to come), step.transaction, step.launchFee,
  // step.deployerBondWei and step.estimatedGasCost. Persist a pending intent BEFORE the wallet
  // submission and the hash immediately after. Sign and send step.transaction from step.owner,
  // wait for a successful canonical receipt, then call prepareLaunch(intent) again.
}
```

See the typechecked [example](../examples/launch.ts), which loops over the steps with a caller-supplied
`send`. The public RPC is rate-limited and a preparation makes dozens of reads: use your own RPC
capacity and transport pacing. Do not treat an RPC error as permission to fall back to unverified calldata.

## Steps

`prepareLaunch` resolves the launch's state on chain and prepares **the next step only**, simulated
from the owner at one observation block. A later step cannot be simulated before the earlier one is
confirmed (the creator account does not exist before setup, and the approval is to that account), so you
confirm each receipt and call again; `step.stages` lists what remains, starting with the step returned.

| Stage | Unsigned transaction | `to` | Native value |
| --- | --- | --- | --- |
| `terms` | `acceptTerms(version, termsHash)`, only while the registry enforces terms and the owner has not accepted | terms registry | `0` |
| `setup` | `createAccountForDraft(draftSalt, beneficiary)` | creator account factory | `0` |
| `reset` | `approve(creatorAccount, 0)`, when a nonzero allowance is below the fee | quote token | `0` |
| `approve` | `approve(creatorAccount, launchFee)` | quote token | `0` |
| `launch` | `launchAuctionWithCommitmentAndExactDuration(name, symbol, floorPriceWad, lockDays, commitmentBps, hours, durationBlocks)` | creator account | **the 0.5 HYPE bond, exactly** |
| `complete` | none; the launch read back | | |

- **Terms.** `step.terms` carries `{ enforced, accepted, requiredVersion, termsHash, uri }`. Show the text at
  `uri` and confirm its keccak256 equals `termsHash` before the owner signs: accepting is the owner's own act.
- **The fee spender and the launch target are the creator account**, never the controller or the bid router.
  Setup records the owner as the account's controller and bond beneficiary and `beneficiary` (default: the owner) as
  the recipient of the creator's fee share. An unlaunched account that differs from the requested owner and
  beneficiary is refused.
- **Gas price.** The `launch` step carries `gasPrice`, the price it was simulated at, because the bond escrow reads
  `tx.gasprice` and refuses launches above 1 gwei. Preserve that field when sending; if the network price is above the
  cap, wait and prepare again (`GAS_PRICE_TOO_HIGH`).
- **Recovery.** A launched identity returns `complete` even if launches have since been paused or funds spent; it
  reports the existing launch and does not apply newly supplied terms. After an ambiguous wallet response, reconcile
  receipts, the wallet nonce and `getLaunch` before retrying; a missing receipt is not proof that nothing was sent.
  Pending wallet transactions block preparation (`PENDING_TRANSACTION`), and a pending nonce that moves while a step
  is prepared invalidates it (`NONCE_CHANGED`).

## Inputs

| Field | Rule |
| --- | --- |
| `owner` | The creator wallet that signs every step |
| `draftSalt` | A nonzero random bytes32, chosen once (`newDraftSalt()`). `launchDealId({ chainId, controller, owner, draftSalt })` is the deal id; the client also reads the controller's own answer and refuses any difference |
| `beneficiary` | Optional; the owner by default |
| `name` | Trimmed, 1 to 80 UTF-8 bytes |
| `symbol` | 1 to 10 uppercase ASCII letters or digits; `OXY` is reserved |
| `floorPriceWad` | The adapter's price scale; see [Launch Floor Rules](#launch-floor-rules) |
| `creatorLockDays` | `0`, `30` or `60` |
| `listingCommitmentBps` | `0`, `5000` or `10000` |
| `auctionDurationHours` | 1 to 24 whole hours |
| `durationBlocks`, `secondsPerBlock` | Optional, see below |

**Duration.** Gen10 launches take an exact CCA length in blocks. The controller accepts 14,400 to 72,000 blocks for
each requested hour (0.25 s down to 0.05 s per block), so 24 hours is at most 1,728,000 blocks.
`auctionDurationBounds(hours)` returns those bounds. For the `launch` step the length is, in order: your
`durationBlocks`; or `round(hours x 3600 / secondsPerBlock)` from your `secondsPerBlock`
(`auctionDurationBlocks({ hours, secondsPerBlock })`); or the same from the rate measured over the last 20,000
blocks, never before the manifest's `startBlock` (`sampleSecondsPerBlock(publicClient, { blocks?, notBefore?, blockNumber? })`;
`INSUFFICIENT_BLOCK_HISTORY` below 1,000 blocks). A rate outside 0.05 to 0.25 s throws `INVALID_DURATION_BLOCKS`
instead of being clamped. The step returns `durationBlocks`, `secondsPerBlock` and the `rateSample` when one was taken;
the authoritative end is the CCA's `endBlock`, which `getLaunch` reports.

## What Is Checked Before A Step Is Returned

1. **Input** is validated without any chain read, including the floor rules below (`FLOOR_BELOW_MINIMUM_RAISE`,
   `FLOOR_ABOVE_MAXIMUM`, `INVALID_FLOOR`).
2. **The launch graph is verified at one block.** The auction graph (`verifyDeployment` of the auctions client: pins,
   bindings, bid-hook rules, the controller's floor cap and its 30,000 USDC net minimum raise) plus the launch pins
   of the manifest: the creator account factory, the entry controller and the bond escrow, each by address and
   runtime code hash (`CODE_MISMATCH`). Their bindings to each other and to the controller, the controller's
   `launchFee()` and the escrow's `CREATOR_DEPOSIT` against the manifest (`LAUNCH_COST_MISMATCH`), and the
   controller's duration bounds against this SDK (`DURATION_BOUNDS_MISMATCH`).
3. **Launch state.** Public launches enabled and not paused (`LAUNCH_PAUSED`); the controller derives the same deal id
   (`LAUNCH_ID_MISMATCH`); the ticker is free (`TICKER_UNAVAILABLE`); the deal id is unused (`DEAL_ID_USED`); the
   adapter's `effectiveFloor` equals the SDK's calculation (`FLOOR_MISMATCH`); an existing creator account is
   registered by the pinned factory and bound to this owner, deal, quote token and bond escrow (`INVALID_CREATOR_ACCOUNT`,
   `CREATOR_BINDING_MISMATCH`). Scheduled launches are not prepared: an account with one pending is refused
   (`LAUNCH_ALREADY_SCHEDULED`).
4. **Wallet.** USDC for the fee (`INSUFFICIENT_QUOTE`), at least the bond in native HYPE (`INSUFFICIENT_BOND`), bond plus the
   step's gas estimate with a 20% buffer (`INSUFFICIENT_GAS`), no pending transaction.
5. **Simulation.** The step is simulated from the owner at the observation block, and its gas estimated, before it
   is returned. A revert is surfaced as `SIMULATION_FAILED` with `details.stage` and, when it is an Oxley rule,
   `details.revert` (`{ name, args, message }` from `decodeOxleyRevert`); the message never carries an RPC URL.
   A token that answers an approval with `false` is `APPROVAL_REJECTED`.

All of this is read at one block and the block is checked to still be canonical when the step is returned (`REORG`).

## Reading The Result

`getLaunch({ owner, draftSalt, beneficiary? })` verifies the launch graph and reads the launch back:

```ts
const result = await launches.getLaunch({ owner, draftSalt });
// result.creatorAccount   null before setup
// result.launched         true once the launch transaction succeeded
// result.launch           null until then; afterwards:
//   coin, auction (the CCA address), auctionId, endBlock, open, dealStatus,
//   schedule { requestedHours, durationBlocks, targetEndTimestamp }, bondHeld
// result.bondRefundable   native bond refund the account has received from the escrow
```

`prepareLaunch` returns the same fields with `stage: 'complete'` once launched. Bidding on and settling the
launched auction is in [auctions](auctions.md); the market it becomes is in [markets](markets.md).

## Offline Builders

`buildCreatorAccount({ chainId, factory, draftSalt, beneficiary })`, `buildLaunchApprovals({ chainId, quoteToken,
creatorAccount, launchFee, currentAllowance })`, `buildAuctionLaunch({ chainId, creatorAccount, ...terms,
durationBlocks, bondWei, gasPrice? })` and `buildAcceptTerms` encode the same calldata without any read. They
validate their input but verify nothing on chain: use `prepareLaunch` for anything you will sign. `buildAuctionLaunch`
returns `value: bondWei`; every other builder returns `value: 0n`.

## Errors

Every failure is an `OxleyError` with a `code` and, where useful, `details`. Besides the codes named above:
`INVALID_LAUNCH`, `INVALID_ADDRESS`, `INVALID_HASH`, `INVALID_NAME`, `INVALID_SYMBOL`, `TICKER_RESERVED`,
`INVALID_LOCK`, `INVALID_COMMITMENT`, `INVALID_DURATION`, `INVALID_BLOCK_RATE`, `INVALID_SAMPLE` (input);
`CHAIN_MISMATCH`, `INVALID_BLOCK`, `AUCTION_BINDING_MISMATCH`, `LAUNCH_BINDING_MISMATCH`, `INVALID_TERMS_STATE`
(verification); `INVALID_GAS_PRICE`. A manifest without launch bindings, or with a bond other than 0.5 HYPE, is refused by
`parseDeployment` (`LAUNCH_BINDINGS_REQUIRED`, `INVALID_LAUNCH_COST`, `INVALID_BOND`). RPC transport errors are
not wrapped. `decodeOxleyRevert` also names the launch reverts (`TickerUnavailable`, `InvalidDurationBlocks`,
`GasPriceTooHigh`, `NewEntriesPaused`, ...) for a revert you get from a wallet.

## Not Prepared Here

Scheduled launches (`scheduleAuctionLaunch`, `executeScheduledLaunch`, `refundScheduledLaunch`), the unused-bond claim,
creator fee claims, handover and the publication of images and metadata are calls on the creator account or the
Oxley app; their ABI is `@oxley/sdk/abis/creator-account.json`. Off-chain editable metadata (images, descriptions,
links) is a separate workflow that this package does not publish.

## Launch Floor Rules

Given the floor price a creator wants, the pure rules tell a form or an agent whether the launch controller will
accept it and what the auction will actually use. They read nothing from a chain and need no wallet;
`prepareLaunch` applies them first.

### Floor Scale

Despite the contract's `floorPriceWad` name, the deployed six-decimal USDC / eighteen-decimal
coin adapter reads **24 decimal places for a human USDC-per-coin price**. For example
`parseUnits('0.00001', 24)` is `10000000000000000000n`, not an eighteen-decimal conversion.
The curve's own lowest floor is `9_959_120_000_000_000_000n` (about $0.00000996); the
controller reverts `FloorPriceAboveMaximum` above `MAX_FLOOR_PRICE_WAD` = 1e21 ($0.001 a
coin). The adapter rounds the floor **up** to a tick, so show the effective price
(`quoteAuctionFloor(...).effectiveFloorPriceWad`), not just the input.

### The Minimum-Raise Rule

Every auction offers `OFFERED_UNITS` = 300,000,000 coins. The bid hook registers an auction
only if `floorPriceQ96 x 300,000,000 coins >= ceil(minimumGrossRaise / 10) x 10 x 2^96`
(`floorPriceQ96` is what `quoteAuctionFloor` returns). A launch with a lower floor reverts. The
controller's figures are fixed at deployment and checked by `verifyDeployment`:

| | Value |
| --- | --- |
| Net minimum raise (`minimumRaise()`, `MINIMUM_NET_RAISE`) | $30,000 (30,000,000,000 base units) |
| Gross minimum (`minimumGrossRaise()`, `MINIMUM_GROSS_RAISE`) | 30,303,030,303: net x 10,000 / 9,900, rounded down, for the 1% platform fee |
| Lowest floor (`minimumRaiseFloor()`) | 101,010,101,030,162,826,490, about $0.00010101 a coin |
| Highest floor (`MAX_FLOOR_PRICE_WAD`) | 1,000,000,000,000,000,000,000 ($0.001 a coin) |
| Opening per-wallet bid ceiling (`ceil(gross / 10)`) | $3,030.303031 |

A form that shows four significant digits should round the lowest floor up, `$0.0001011`, so
the number shown can be typed and passes. All amounts are USDC (Oxy-USDC on testnet).

### Functions

- `quoteAuctionFloor(floorPriceWad)` mirrors the adapter: returns `{ floorPriceQ96,
  tickSpacingQ96, effectiveFloorPriceWad }` and throws `INVALID_FLOOR` for a floor the adapter
  itself refuses (under the curve's minimum, or outside the CCA's bounds).
- `floorReachesMinimumRaise(floorPriceWad)` is the rule above, as a boolean.
- `minimumRaiseFloor()` is the exact lowest floor that passes.
- `validateLaunchFloor(floorPriceWad)` throws `FLOOR_ABOVE_MAXIMUM` above 1e21,
  `FLOOR_BELOW_MINIMUM_RAISE` below the lowest floor, or `INVALID_FLOOR` from
  `quoteAuctionFloor`.
- `OFFERED_UNITS` (300,000,000 coins in 18-decimal base units) is exported here only;
  `MAX_FLOOR_PRICE_WAD`, `MINIMUM_NET_RAISE` and `MINIMUM_GROSS_RAISE` also from the root and
  from `/auctions`.
- `launchFloorAbi` (the adapter's `effectiveFloor`), `launchFloorCapAbi` and
  `launchMinimumRaiseAbi` (the controller's cap and minimum-raise views) are typed fragments
  of the compiler ABIs (`abis/adapter.json`, `abis/auction-controller.json`) for cross-checking
  these figures on chain.

```ts
import { parseUnits } from 'viem';
import { minimumRaiseFloor, quoteAuctionFloor, validateLaunchFloor } from '@oxley/sdk/launch';

const floorPriceWad = parseUnits('0.00015', 24); // 24 decimals for a human USDC-per-coin price
validateLaunchFloor(floorPriceWad);              // throws FLOOR_BELOW_MINIMUM_RAISE, FLOOR_ABOVE_MAXIMUM or INVALID_FLOOR
const { effectiveFloorPriceWad } = quoteAuctionFloor(floorPriceWad);
const lowest = minimumRaiseFloor();
```

See the typechecked [floor example](../examples/launch-floor.ts).
