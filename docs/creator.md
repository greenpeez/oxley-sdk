# Creator Actions

What a creator does after the first launch step, all as **unsigned, simulated transactions** (or typed data to sign) with no Oxley backend, API key or signer:

| Action | Call | Who may send it |
| --- | --- | --- |
| [Schedule a launch](#scheduled-launches) | `launches.prepareScheduledLaunch({ ...launch, startTime })` | The owner (the creator account's controller) |
| [Read a schedule](#scheduled-launches) | `launches.getScheduledLaunch(account)` | Read-only |
| [Execute a due schedule](#execute) | `launches.prepareExecuteScheduledLaunch({ creatorAccount, caller? })` | **Anyone**, from the start for 24 hours |
| [Refund a schedule that did not run](#refund) | `launches.prepareRefundScheduledLaunch({ creatorAccount, caller? })` | **Anyone**, after the 24 hour window |
| Claim a refunded launch fee that could not be paid | `launches.prepareClaimScheduledFee({ creatorAccount, caller? })` | **Anyone**; it pays the deployer only |
| [Read the unused bond](#bond-refund) | `launches.getBondRefund({ dealId })` | Read-only |
| [Claim the unused bond](#bond-refund) | `launches.prepareBondRefundClaim({ dealId, owner, recipient? })` | **The original creator wallet only** |
| [Read creator fees](#creator-fees) | `launches.getCreatorFees({ dealId, recipient? })` | Read-only |
| [Claim creator fees](#creator-fees) | `launches.prepareCreatorFeeClaim({ dealId, recipient?, caller? })` | Anyone; it pays the recorded recipient only |
| [Publish token details and image](#token-details-and-image) | `@oxley/sdk/metadata` | The creator account's controller signs; anyone with the signature sends |

All amounts are USDC (Oxy-USDC on testnet) except the **native HYPE** the contracts require of the creator's wallet: the 0.5 HYPE operating bond and gas.
The SDK adds no sponsorship and no USDC-to-HYPE conversion, and HYPE is not a fee, bid or trade asset. Chain: Elysium (testnet chain id 99801). Gen10 only.

**Naming the account.** Every read and claim below takes the launch's identity `{ owner, draftSalt, beneficiary? }` (the salt the creator persisted; `launchDealId` derives the deal),
**or the account's address `{ creatorAccount }`, or the launched market `{ dealId }`**, because the salt is the creator's own record and a bot, a keeper or a new device has only what the
chain and the indexed data show. `owner` may be added to the last two: it must then be the account's creator. The result's `owner` is always the account's original creator. Preparing a launch or
a schedule (`prepareLaunch`, `prepareScheduledLaunch`) needs the salt. Every call verifies the whole launch graph at one block first (pins, bindings, fee, bond), checks the account is the one the
pinned factory registered for its creator and deal (`INVALID_CREATOR_ACCOUNT`, `CREATOR_BINDING_MISMATCH`), simulates from the sending wallet and re-checks the block (`REORG`).
A `{ dealId }` that was never launched has no account yet, so its schedule is `none`. Read the [launch guide](launch.md) first.

## Scheduled Launches

A scheduled launch starts at a time the creator chooses, from 15 minutes to 8 days ahead, instead of opening at once. It is `scheduleAuctionLaunch(terms, startTime)` on the creator account.
**There is no cancel.** The launch fee (1.5 USDC) and the 0.5 HYPE bond are taken when it is scheduled and held in the account, the ticker is held until the window closes
(`start + 24 h`), and the funds leave only through the launch or, if it could not run, a refund.

```ts
// `launches` and `intent` are as in the launch guide.
const step = await launches.prepareScheduledLaunch({ ...intent, startTime: Math.floor(Date.now() / 1000) + 3 * 3600 });
// step.stage: 'terms' | 'setup' | 'reset' | 'approve' | 'schedule'; sign and send step.transaction from the owner,
// confirm the receipt, then call again with the same input. The last step is 'schedule'.
```

`prepareScheduledLaunch` takes the launch input of [prepareLaunch](launch.md#inputs) plus `startTime` (whole Unix seconds). Its steps are the immediate launch's, ending in `schedule` instead of
`launch`: the terms acceptance (only while the registry enforces it), the creator account, the fee approval **to the account**, then `scheduleAuctionLaunch`, which carries the 0.5 HYPE
bond as its `value` and the `gasPrice` it was simulated at (the schedule's own dry run opens the auction once, so the bond escrow's 1 gwei cap applies).

| Check | Code |
| --- | --- |
| `startTime` is a whole positive number | `INVALID_START_TIME` (before any chain read) |
| At least 18 minutes ahead: the contract's 15 minutes plus the three minutes a step takes to sign | `LAUNCH_START_TOO_SOON` |
| At most 7 days 23 hours ahead: the contract's 8 days less an hour, because Elysium makes no empty blocks and a dry run against an old head sees an earlier clock | `LAUNCH_START_TOO_FAR` |
| The ticker is not taken by an open auction or another schedule | `TICKER_UNAVAILABLE` |
| The ticker's last hold did not lapse unused within the controller's 3 day cooldown (launching it now stays open) | `TICKER_COOLDOWN`, with `details.scheduleFrom` |
| The account's bond, 15 minute and 8 day bounds, 24 hour window, name limit and dry-run gas limit, and the controller's cooldown, are the ones this SDK mirrors | `SCHEDULE_RULES_MISMATCH` |
| Public launches enabled and not paused | `LAUNCH_PAUSED` |
| The gas price is at most the bond escrow's 1 gwei | `GAS_PRICE_TOO_HIGH` |
| USDC for the fee, the bond, and the gas | `INSUFFICIENT_QUOTE`, `INSUFFICIENT_BOND`, `INSUFFICIENT_GAS` |

The margins on the start time are the live app's (`SCHEDULE_SERVER_MIN_LEAD`, `SCHEDULE_ACCEPTED_MAX_LEAD`); `scheduleStartBounds(now)` returns them and `validateScheduleStart(startTime, now)`
applies them. The exact duration in blocks is fixed when the launch is scheduled (from your `durationBlocks`, your `secondsPerBlock` or the measured block rate, as for a launch).
The result carries `plan: { startTime, executionWindowEndsAt, tickerHeldUntil, cancellable: false }`.

Gen10's keeper normally executes a scheduled launch at its start second. The app refuses to offer scheduling while its keeper does not report itself ready for the launch; the SDK cannot see
the keeper. A bot that schedules should therefore be ready to execute its own launch (below) if the keeper has not within a few minutes. The keeper never refunds.

### Reading A Schedule

`getScheduledLaunch(account)` reads the schedule of a creator account at one block:

| Field | Meaning |
| --- | --- |
| `phase` | `none`, `pending` (before the start), `executable` (from the start to 24 hours after it, both inclusive), `expired` (after the window without a launch: refundable), `executed` (the schedule ran), `refunded` (refunded, its bond still in the account) |
| `executable`, `refundable` | `phase` as booleans |
| `startTime`, `windowEndsAt`, `secondsUntilStart`, `secondsRemaining` | Unix seconds and the time left |
| `terms` | `{ name, symbol, floorPriceWad, creatorLockDays, listingCommitmentBps, auctionDurationHours, durationBlocks }` as the account stored them (readable after the launch ran too) |
| `heldBondWei`, `feeOwed`, `bondRefundable` | The bond the account holds for the schedule; a refunded launch fee the deployer could not receive; the bond refund balance |
| `tickerHold` | `{ holder, until }` on the controller, if any |
| `time` | `{ chain, clock, reference, quiet }`: the head block's timestamp, the clock, the time the phase was judged at, and whether the chain is quiet |

`none` covers an account that never scheduled, an immediate launch, and a schedule that was refunded and whose bond was claimed: the account keeps no record of the last two.

**Time.** A live chain's head timestamp is the clock the simulation runs at, so it decides. A quiet chain (head at least 10 minutes behind the clock; Elysium makes no empty blocks) says nothing
about now: the clock less a minute of skew stands in. Pass `now: () => unixSeconds` to `createOxleyLaunchClient` to supply your own clock.

`getLaunch` carries `scheduled`, `scheduledStart` and `handoverCount`. `prepareLaunch` and `prepareScheduledLaunch` **route** an account that has a schedule pending instead of refusing it
(`LAUNCH_ALREADY_SCHEDULED` is no longer raised): `stage: 'scheduled'` before the start (`transaction: null`, nothing to send; `schedule` carries the state), `'execute'` in the window and `'refund'`
after it. The chain's stored schedule wins over the input's terms and `startTime`.

### Execute

`executeScheduledLaunch()` opens the auction with the fee and bond posted at scheduling. **Anyone may send it** from `startTime` for 24 hours (both ends inclusive); the protocol keeper normally does, and
the bond escrow repays the sender's gas from the creator's bond (at most 12,000,000 gas at at most 1 gwei).

```ts
const run = await launches.prepareExecuteScheduledLaunch({ creatorAccount, caller: executorWallet }); // or { owner, draftSalt }
// run.transaction: to the creator account, value 0, gasPrice (at most 1 gwei) and gas (the estimate plus a fifth, at most 12,000,000)
```

The step is simulated from `caller` (default: the owner), which pays the gas up front. Refusals: `SCHEDULE_NOT_DUE` (`details.secondsUntilStart`), `SCHEDULE_WINDOW_CLOSED` (refund it instead),
`ALREADY_LAUNCHED`, `NOT_SCHEDULED`, `LAUNCH_PAUSED` (an entry gate that is paused would revert the execution), `CREATOR_TERMS_NOT_ACCEPTED` (the creator must still stand on the current
terms), `GAS_PRICE_TOO_HIGH` (the account reverts above 1 gwei), `SCHEDULE_EXECUTION_TOO_EXPENSIVE` (over the 12,000,000 gas the escrow repays), `INSUFFICIENT_GAS`.
The keeper's `PAUSED_LAUNCH_GENERATIONS` switch belongs to the generations whose entry gate it paused (Gen9's, at the Gen10 switch-over) and does not apply to Gen10; the entry gate itself is what the SDK reports as `LAUNCH_PAUSED`.
On a quiet chain whose head is still before the start, a due launch cannot be simulated (the head's clock says "not yet"): the step is returned with `simulated: false`,
`simulationSkipped` and the full 12,000,000 gas limit, as the keeper sends it; the transaction's own block carries the real time.

### Refund

`refundScheduledLaunch()` is open to **anyone strictly after the window** closed without a launch: the launch fee returns to the deployer (the original creator) and the 0.5 HYPE bond becomes the
account's refund balance, which only the original creator claims ([below](#bond-refund)). The sender pays the gas; nothing repays it, and the keeper does not send it. The account is then fresh again:
`prepareLaunch` prepares a new launch or schedule from the fee approval. Refusals: `SCHEDULE_NOT_EXPIRED` (`details.windowEndsAt`), `ALREADY_LAUNCHED`, `ALREADY_REFUNDED`, `NOT_SCHEDULED`.
A fee the deployer could not receive stays as `feeOwed`; `prepareClaimScheduledFee` (anyone) pays it to the deployer only.

## Bond Refund

The 0.5 HYPE operating bond funds the auction's delivery and refund gas through the bond escrow, which returns what is unused to the creator account when settlement completes (a refunded
schedule returns its bond directly). The escrow also repays the account the gas of opening the auction (it prepares the delivery batcher then, in the creator's own transaction), so on a live
auction the balance is small and already `available` while the escrow still holds the rest. The account holds all of it for the **original creator**: `claimBondRefund(recipient)` pays the whole
refund balance, in native HYPE, with a 30,000 gas call, and only the account's `bondBeneficiary` (the owner, fixed at creation and kept through any handover) may send it. It first withdraws any
credit the escrow could not pay the account.

```ts
const bond = await launches.getBondRefund({ dealId });                 // or { owner, draftSalt } or { creatorAccount }
// bond.refundable (wei) = bond.accountBalance + bond.escrowCredit; bond.claimable; bond.reason; bond.message; bond.processing; bond.escrow
if (bond.claimable) {
  const claim = await launches.prepareBondRefundClaim({ dealId, owner, recipient: owner }); // simulated from the owner, who must be the original creator
}
```

| `reason` | Meaning |
| --- | --- |
| `available` | Something can be claimed now (`processing` may say more follows when settlement completes) |
| `processing` | Settlement is still running; the unused bond returns when it completes |
| `scheduled` | The bond is held for a pending schedule; it becomes claimable if the schedule is refunded |
| `empty` | Nothing to claim: it was claimed, or the auction used it |
| `not-launched` | No bond has been posted for this account |
| `not-beneficiary` | The `claimant` you asked about is not the original creator |

`prepareBondRefundClaim` refuses what the chain would not pay: `NOTHING_TO_CLAIM`, `BOND_NOT_CLAIMABLE` (`details.reason`), `INVALID_RECIPIENT` (the account itself), and `BOND_PAYMENT_REJECTED`
when the simulation returns `false` (the recipient cannot take the 30,000 gas native payment, as a smart wallet with a heavy receive cannot; the balance stays in the account). The owner pays the gas.

## Creator Fees

The creator's share of trading fees (USDC) accrues in the fee router and is collected by the creator account, which credits it to the account's `beneficiary` (the owner unless the launch named
another). **Anyone may send `claimFees(recipient)`, but it pays only the fees credited to `recipient`**; the current beneficiary accrues new fees and a previous beneficiary keeps what was credited
before a handover.

```ts
const fees = await launches.getCreatorFees({ dealId });                  // recipient defaults to the account's beneficiary
// fees.pending (USDC base units), fees.credited, fees.uncheckpointed, fees.unlockAt, fees.active, fees.claimable, fees.reason, fees.message
const claim = await launches.prepareCreatorFeeClaim({ dealId, caller }); // simulated from the caller (default: the creator); its return value must equal fees.pending
```

Claims open once the auction has succeeded (`active`) and the creator lock has ended (`unlockAt`), judged at the head block's time. `reason`: `available`, `locked`, `inactive` (the auction has not
succeeded), `empty`, `not-launched`, `not-beneficiary` (the recipient is not the beneficiary and has no credit). The matching codes are `CREATOR_FEES_LOCKED` (`details.unlockAt`),
`CREATOR_FEES_INACTIVE`, `NOTHING_TO_CLAIM`, `NOT_LAUNCHED`, `NOT_BENEFICIARY`; `FEES_CHANGED` means the simulated payment differs from the amount read.
The fee router is not a manifest pin: it is the one the pinned curve and bid router report to (`CREATOR_BINDING_MISMATCH` otherwise), and `abis/fee-router.json` is its published compiler ABI.

## Token Details And Image

Names, tickers and every financial term are on chain and cannot change. The description, three links and the image are published off chain through Oxley's token details service
(`/api/elysium/token-metadata`, `/api/elysium/token-images` of the application, `https://app.oxley.fun`), signed by the creator account's controller.

```ts
import { createOxleyMetadataClient } from '@oxley/sdk/metadata';

const details = createOxleyMetadataClient();                    // baseUrl defaults to https://app.oxley.fun
const launch = await launches.getLaunch({ owner, draftSalt });  // the creator account, coin, handover epoch and controller, from chain
const prepared = await details.prepareMetadataPublication({
  dealId: launch.dealId, coin: launch.launch!.coin, creator: launch.creatorAccount!,
  epoch: launch.handoverCount, controller: launch.accountController!,
  metadata: { description: 'Example', website: 'https://example.com', x: 'https://x.com/example', telegram: '' },
});
const signature = await wallet.signTypedData(prepared.signing.typedData); // the controller signs; the SDK never holds a key
const record = await details.submitMetadataPublication(prepared, signature, { publicClient });
```

**How it authenticates.** Three things must hold, and the SDK builds all three:

1. **The signed intent** names the chain, deal, coin and creator account, the SHA-256 of the canonical details, the expected revision, the application's **origin** and the issue time. The server rebuilds
   the message from it (`prepared.message`, the exact text), refuses an origin that is not its own, and accepts a time from 590 seconds behind to 25 seconds ahead of **its** clock (an image: 600 and 30).
   `issuedAt` defaults to the service's clock, read from its `Date` header and advanced by monotonic time, never the device's.
2. **The creator account verifies the signature on chain** (`isValidPublicationSignature`). The creator is the account contract, so the controller signs **EIP-712 typed data**, not the message:
   domain `OxleyCreatorPublication` version `8`, chain 99801, the account as verifying contract; `Publication(bytes32 purpose, bytes32 payloadHash, uint256 epoch, uint64 deadline)` with the purpose
   `keccak256("OXLEY_TOKEN_METADATA_GEN8")` (images: `..._IMAGE_GEN8`), `payloadHash = hashMessage(message)`, `epoch` the account's `handoverCount` (a handover invalidates earlier signatures)
   and `deadline = issuedAt + 600`. `prepared.signing` is that typed data (`method: "eth_signTypedData_v4"`); a creator that is a plain wallet signs the message (`method: "personal_sign"`).
3. **The request carries the application's `Origin` header** (`https://app.oxley.fun`). Node sets it; a browser on another site cannot, and the service gives write routes no cross-origin access,
   by design. Publishing therefore runs from Node, bots and agents, or from the application's own pages. Reads need no origin.

The SDK checks the signature before it sends anything: the signer must be the expected controller (`SIGNER_MISMATCH`), and with a `publicClient` the creator account itself must accept it
(`SIGNATURE_REJECTED`). Only 65 byte signatures are accepted (`SIGNATURE_UNSUPPORTED` for smart-account and passkey signatures, as the service does); `v` 0 and 1 are converted to 27 and 28.
Sign and submit within about nine minutes (`prepared.expiresAt`).

| Rule | Value |
| --- | --- |
| Description | Up to 2,000 characters; control characters other than tab and line breaks refused; trimmed, line breaks normalized |
| Links (`website`, `x`, `telegram`) | HTTPS only, no credentials, up to 512 characters; `x` on x.com or twitter.com, `telegram` on t.me; empty clears one |
| Fields | Exactly these four; anything else is refused. An empty value clears the field |
| Revision | `expectedRevision` defaults to the saved revision (0 when none); a stale one is refused (`DETAILS_CHANGED`) |
| Image | PNG, JPEG or WebP, 1 to 900,000 bytes, one frame, at most 16 million pixels; the service stores a 512 x 512 WebP **once, forever** (a second publication returns the stored CID) |
| Body | The details request at most 16,384 bytes |

`prepareImagePublication({ ..., image: bytes })` and `submitImagePublication(prepared, signature)` do the same for the image (multipart `image`, `intent`, `signature`); it resolves with the CID.
A busy service (429, 500, 502, 503, 504) is retried with the same signature (a signed save is idempotent for one revision): 6 attempts within 45 seconds for details, 3 for an image.
Server refusals keep their codes in `OxleyError.code`: `SIGNATURE_EXPIRED`, `NOT_CREATOR`, `DETAILS_CHANGED`, `ORIGIN_MISMATCH`, `SIGNATURE_UNSUPPORTED`, `CAPACITY_LIMITED`, `COMMIT_UNCONFIRMED`,
with `details.status`, `details.requestId` and `details.retryAfterMs`. `COMMIT_UNCONFIRMED` raised by the SDK means the service accepted the save but its echo did not confirm it: read the record.

What the SDK cannot do: decode pixels (a corrupt file is refused by the server), publish from another website's browser page, or sign. `readTokenMetadata(dealIds)` reads saved details in
batches of 50; `resolveToken(dealId)` and `readPublisher(...)` ask the service for the coin, creator and signing authority (take them from `getLaunch` when the signature matters).

Typechecked examples: [scheduled launch](../examples/scheduled-launch.ts), [creator claims](../examples/creator.ts), [token details](../examples/token-metadata.ts).
