import type { Address, Hex } from "viem";
import { curveAbi } from "./curve-abis.js";
import { auctionBidRouterAbi } from "./auction-abis.js";
import { buildClaimBondRefund, buildClaimCreatorFees } from "./creator-transactions.js";
import { creatorAccountAbi, creatorFeeRouterAbi, launchBondAbi } from "./launch-abis.js";
import { checkNonce, readWallet, simulateStep } from "./launch-step.js";
import { referenceTime, scheduledPhase } from "./schedule-rules.js";
import { address, check, OxleyError, sameAddress } from "./validation.js";
import type { Anchor } from "./types.js";
import type { LaunchContext } from "./launch-context.js";
import type { CreatorRef, LaunchReader, LaunchState } from "./launch-account.js";
import type { CallerOption } from "./launch-types.js";

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** The one 32-byte word a simulated claim returns (a bool or a uint256), or undefined when the call returned nothing or something else: an empty answer is not a claim. */
const claimWord = (data: Hex | undefined) => data && /^0x[0-9a-fA-F]{64}$/.test(data) ? BigInt(data) : undefined;
export type BondRefundReason = "available" | "processing" | "scheduled" | "empty" | "not-launched" | "not-beneficiary";
export type CreatorFeesReason = "available" | "locked" | "inactive" | "empty" | "not-launched" | "not-beneficiary";
const BOND_MESSAGES: Readonly<Record<BondRefundReason, string>> = {
  available: "The unused operating bond can be claimed now",
  processing: "The auction is still being settled; the unused bond returns to the creator account when settlement completes",
  scheduled: "The bond is held for the scheduled launch; it becomes claimable if the schedule is refunded",
  empty: "There is no unused bond to claim (it was claimed, or the auction used it)",
  "not-launched": "No bond has been posted for this creator account yet",
  "not-beneficiary": "Only the original creator wallet can claim the bond",
};
const FEE_MESSAGES: Readonly<Record<CreatorFeesReason, string>> = {
  available: "Creator fees can be claimed now",
  locked: "Creator fees stay locked until the creator lock ends",
  inactive: "Creator fees open once the auction has succeeded",
  empty: "No creator fees are waiting",
  "not-launched": "This creator account has not launched",
  "not-beneficiary": "This address is not the fee beneficiary and has no credited fees",
};
const FEE_CODES: Readonly<Partial<Record<CreatorFeesReason, string>>> = { locked: "CREATOR_FEES_LOCKED", inactive: "CREATOR_FEES_INACTIVE", empty: "NOTHING_TO_CLAIM",
  "not-launched": "NOT_LAUNCHED", "not-beneficiary": "NOT_BENEFICIARY" };

export function createCreatorActions(context: LaunchContext, reader: LaunchReader, clock: () => number) {
  const { rpc, deployment, pins, verifyDeployment, canonical } = context;
  const chainId = deployment.chainId, quote = deployment.quoteToken, symbol = quote.symbol;

  async function prologue(input: CreatorRef) {
    check(!!input && typeof input === "object", "INVALID_LAUNCH", "Launch identity required");
    const { blockNumber, blockHash, timestamp } = await verifyDeployment(), at: Anchor = { blockNumber, blockHash, timestamp };
    return { at, state: await reader.stateAt(input, at) };
  }
  /**
   * The unused operating bond of a creator account at the observation block: what the account holds for the original creator (`bondRefundBalance`, native HYPE the bond escrow
   * has paid it) plus any credit the escrow could not pay and `claimBondRefund` withdraws first, and why it can or cannot be claimed yet. The bond itself stays with the escrow,
   * which repays the auction's delivery and refund gas from it and returns the rest when settlement completes (`escrow.complete`); a refunded schedule returns its bond directly.
   */
  async function bondAt(state: LaunchState, at: Anchor, claimant: Address) {
    const account = state.creatorAccount, blockNumber = at.blockNumber, escrow = pins.bondEscrow.address;
    const [credit, fund] = account ? await Promise.all([rpc.readContract({ address: escrow, abi: launchBondAbi, functionName: "credits", args: [account], blockNumber }),
      rpc.readContract({ address: escrow, abi: launchBondAbi, functionName: "funds", args: [state.dealId, account], blockNumber })]) : [0n, null];
    const total = state.bondRefundable + credit, processing = fund !== null && fund[5] && !fund[6];
    const phase = scheduledPhase(state, referenceTime(at.timestamp, clock()).reference);
    const reason: BondRefundReason = !account ? "not-launched" : state.bondBeneficiary !== null && !sameAddress(claimant, state.bondBeneficiary) ? "not-beneficiary"
      : total > 0n ? "available" : ["pending", "executable", "expired"].includes(phase) ? "scheduled" : processing ? "processing" : state.launched || fund?.[5] ? "empty" : "not-launched";
    return Object.freeze({ creatorAccount: account, bondBeneficiary: state.bondBeneficiary,
      /** Native HYPE in wei that `claimBondRefund` pays now: the account's refund balance plus the escrow's credit. More may follow while `processing`. */
      refundable: total, accountBalance: state.bondRefundable, escrowCredit: credit,
      /** The escrow's own record for this auction: the bond it still holds (`balance`), whether the bond was posted (`funded`) and settlement is finished (`complete`). */
      escrow: fund && { balance: fund[0], funded: fund[5], complete: fund[6], outcome: (["pending", "failed", "successful"] as const)[fund[4]] ?? "pending" },
      processing, claimable: reason === "available", reason,
      message: reason === "available" && processing ? "The unused operating bond can be claimed now; more returns when settlement completes" : BOND_MESSAGES[reason] });
  }
  /** Reads what `claimBondRefund` would pay and why it can or cannot be claimed yet. `claimant` (default: `owner` when named, else the account's creator) is the wallet that would send it. */
  async function getBondRefund(input: CreatorRef & { claimant?: Address }) {
    if (input?.claimant !== undefined) address(input.claimant);
    const { at, state } = await prologue(input), bond = await bondAt(state, at, (input.claimant ?? input.owner ?? state.owner ?? state.bondBeneficiary) as Address);
    await canonical(at);
    return { ...at, owner: state.owner, dealId: state.dealId, ...bond };
  }
  /**
   * `claimBondRefund(recipient)` from the original creator wallet (`owner`, or the account's creator when only the account or deal is named): pays the refundable bond to `recipient` (default: the owner) in native HYPE. The contract pays it
   * with a 30,000 gas call, so a recipient that cannot take that leaves the balance in place and the call returns `false` (`BOND_PAYMENT_REJECTED`). Gas is paid by the sender.
   */
  async function prepareBondRefundClaim(input: CreatorRef & { recipient?: Address }) {
    if (input?.recipient !== undefined) address(input.recipient);
    const { at, state } = await prologue(input), blockNumber = at.blockNumber;
    // The sender is the wallet named as the owner, else the account's creator: only that wallet can claim the bond.
    const sender = (input.owner ?? state.owner ?? state.bondBeneficiary) as Address, recipient = input.recipient ?? sender;
    const bond = await bondAt(state, at, sender);
    if (!bond.claimable) throw new OxleyError(bond.reason === "empty" || bond.reason === "not-launched" ? "NOTHING_TO_CLAIM" : "BOND_NOT_CLAIMABLE", bond.message,
      { reason: bond.reason, refundable: bond.refundable });
    const wallet = await readWallet(rpc, sender, blockNumber), transaction = buildClaimBondRefund({ chainId, creatorAccount: state.creatorAccount!, recipient });
    const { data, gasEstimate } = await simulateStep(rpc, "claim-bond", { to: transaction.to, data: transaction.data, value: 0n, account: sender, blockNumber }, symbol);
    check(claimWord(data) === 1n, "BOND_PAYMENT_REJECTED",
      "The recipient cannot take the native payment (the contract forwards 30,000 gas); choose a plain wallet address as the recipient");
    const estimatedGasCost = ceil(gasEstimate * 120n, 100n) * wallet.gasPrice;
    check(wallet.native >= estimatedGasCost, "INSUFFICIENT_GAS", "The creator wallet needs native HYPE for the claim's gas");
    await canonical(at); await checkNonce(rpc, sender, wallet.nonce);
    return { ...at, stage: "claim-bond" as const, stages: ["claim-bond" as const], transaction, owner: sender, recipient, dealId: state.dealId, creatorAccount: state.creatorAccount!,
      expectedAmount: bond.refundable, bond, nativeBalance: wallet.native, nonce: wallet.nonce, gasPrice: wallet.gasPrice, gasEstimate, estimatedGasCost, simulated: true as const };
  }

  /** The creator account's fee ledger and the fee router's lock for `recipient` (default: the account's current beneficiary) at the observation block. */
  async function feesAt(state: LaunchState, at: Anchor, recipientOption?: Address) {
    const account = state.creatorAccount, blockNumber = at.blockNumber;
    if (!account) return { creatorAccount: null, recipient: recipientOption ?? null, beneficiary: null, pending: 0n, credited: 0n, uncheckpointed: 0n, routerClaimable: 0n, unlockAt: null,
      active: false, claimable: false, reason: "not-launched" as const, message: FEE_MESSAGES["not-launched"], quoteAsset: quote.address };
    const beneficiary = state.beneficiary!, recipient = recipientOption ?? beneficiary;
    const [pending, credited, router, curveRouter, bidRouterRouter] = await Promise.all([
      rpc.readContract({ address: account, abi: creatorAccountAbi, functionName: "pendingFees", args: [recipient], blockNumber }),
      rpc.readContract({ address: account, abi: creatorAccountAbi, functionName: "feeCredits", args: [recipient], blockNumber }),
      rpc.readContract({ address: account, abi: creatorAccountAbi, functionName: "feeRouter", blockNumber }),
      rpc.readContract({ address: deployment.curve.address, abi: curveAbi, functionName: "feeRouter", blockNumber }),
      rpc.readContract({ address: deployment.auctionBindings.bidRouter.address, abi: auctionBidRouterAbi, functionName: "feeRouter", blockNumber })]);
    // The fee router is not a manifest pin: it is the one the pinned curve and bid router report to, and the creator account (registered by the pinned factory) was built with it.
    check(sameAddress(router, curveRouter) && sameAddress(router, bidRouterRouter), "CREATOR_BINDING_MISMATCH", "The creator account's fee router is not the one the curve and bid router report to");
    const [config, routerClaimable] = await Promise.all([rpc.readContract({ address: router, abi: creatorFeeRouterAbi, functionName: "dealConfig", args: [state.dealId], blockNumber }),
      rpc.readContract({ address: router, abi: creatorFeeRouterAbi, functionName: "creatorClaimable", args: [state.dealId, quote.address], blockNumber })]);
    check(!state.launched || sameAddress(config[0], account), "LAUNCH_BINDING_MISMATCH", "The fee router's deal does not name this creator account");
    const [, , unlockAt, active] = config, now = Number(at.timestamp);
    const reason: CreatorFeesReason = !state.launched ? "not-launched" : !sameAddress(recipient, beneficiary) && credited === 0n ? "not-beneficiary" : !active ? "inactive"
      : now < Number(unlockAt) ? "locked" : pending === 0n ? "empty" : "available";
    return { creatorAccount: account, recipient, beneficiary, pending, credited, uncheckpointed: pending - credited, routerClaimable, unlockAt: active ? Number(unlockAt) : null, active,
      claimable: reason === "available", reason, message: FEE_MESSAGES[reason], quoteAsset: quote.address };
  }
  /**
   * What `claimFees(recipient)` would pay in USDC (Oxy-USDC on testnet) and why it can or cannot be claimed yet. `pending` is `pendingFees(recipient)`: fees credited to the
   * recipient plus, for the current beneficiary, those the account has not yet checkpointed (`uncheckpointed`, collected from the router when claimed). Claims open once the auction
   * has succeeded (`active`) and the creator lock has ended (`unlockAt`), judged at the head block's time.
   */
  async function getCreatorFees(input: CreatorRef & { recipient?: Address }) {
    if (input?.recipient !== undefined) address(input.recipient);
    const { at, state } = await prologue(input), fees = await feesAt(state, at, input.recipient);
    await canonical(at);
    return { ...at, owner: state.owner, dealId: state.dealId, ...fees };
  }
  /**
   * `claimFees(recipient)`: anyone may send it, but it pays only the fees credited to `recipient`, never a caller-chosen amount. The recipient defaults to the account's current
   * beneficiary (the owner unless the launch named another); after a handover a previous beneficiary's credit is claimed by naming that address. The step is simulated from
   * `caller` (default: the owner), which pays the gas, and its return value must equal `pending`.
   */
  async function prepareCreatorFeeClaim(input: CreatorRef & CallerOption & { recipient?: Address }) {
    if (input?.recipient !== undefined) address(input.recipient);
    if (input?.caller !== undefined) address(input.caller);
    const { at, state } = await prologue(input), fees = await feesAt(state, at, input.recipient), blockNumber = at.blockNumber;
    const caller = input.caller ?? input.owner ?? state.owner;
    if (!fees.claimable) throw new OxleyError(FEE_CODES[fees.reason]!, fees.message, { reason: fees.reason, unlockAt: fees.unlockAt, pending: fees.pending });
    const wallet = await readWallet(rpc, caller!, blockNumber), transaction = buildClaimCreatorFees({ chainId, creatorAccount: state.creatorAccount!, recipient: fees.recipient! });
    const { data, gasEstimate } = await simulateStep(rpc, "claim-fees", { to: transaction.to, data: transaction.data, value: 0n, account: caller!, blockNumber }, symbol);
    check(claimWord(data) === fees.pending, "FEES_CHANGED", "The simulated claim does not pay the pending amount read; prepare again");
    const estimatedGasCost = ceil(gasEstimate * 120n, 100n) * wallet.gasPrice;
    check(wallet.native >= estimatedGasCost, "INSUFFICIENT_GAS", "The caller needs native HYPE for the claim's gas");
    await canonical(at); await checkNonce(rpc, caller!, wallet.nonce);
    return { ...at, stage: "claim-fees" as const, stages: ["claim-fees" as const], transaction, owner: state.owner, caller: caller!, recipient: fees.recipient!, dealId: state.dealId,
      creatorAccount: state.creatorAccount!, expectedAmount: fees.pending, fees, nativeBalance: wallet.native, nonce: wallet.nonce, gasPrice: wallet.gasPrice, gasEstimate, estimatedGasCost,
      simulated: true as const };
  }
  return { getBondRefund, prepareBondRefundClaim, getCreatorFees, prepareCreatorFeeClaim };
}
export type CreatorActions = ReturnType<typeof createCreatorActions>;
