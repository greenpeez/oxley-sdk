import { zeroAddress } from "viem";
import { registryAbi, tokenAbi } from "./abis.js";
import { launchFloorAbi } from "./auction-abis.js";
import { buildAcceptTerms, readTermsStatus } from "./client-terms.js";
import { launchControllerAbi } from "./launch-abis.js";
import { auctionDurationBlocks, checkDurationBlocks, sampleSecondsPerBlock } from "./launch-duration.js";
import { quoteAuctionFloor } from "./launch-floor.js";
import { validateAuctionLaunch } from "./launch-input.js";
import { buildAuctionLaunch, buildCreatorAccount, buildLaunchApprovals } from "./launch-transactions.js";
import { decodeOxleyRevert } from "./revert.js";
import { check, OxleyError, sameAddress } from "./validation.js";
import type { Anchor } from "./types.js";
import type { LaunchContext } from "./launch-context.js";
import type { LaunchReader } from "./launch-account.js";
import type { AuctionLaunchInput, LaunchStage, LaunchTransaction } from "./launch-types.js";

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** A failed read-only call, with the Oxley rule it hit when the revert decodes. The RPC URL a client error may carry is never passed on. */
function failure(stage: LaunchStage, what: "simulation" | "gas estimate", cause: unknown, symbol: string): never {
  const revert = decodeOxleyRevert(cause, { quoteSymbol: symbol });
  const reason = String((cause as { shortMessage?: string })?.shortMessage ?? (cause as Error)?.message ?? cause).split("\n")[0]!.replace(/https?:\/\/\S+/g, "<rpc>");
  throw new OxleyError("SIMULATION_FAILED", revert ? `The ${stage} step failed in ${what}: ${revert.message}` : `The ${stage} step failed in ${what}: ${reason}`,
    { stage, revert: revert ? { name: revert.name, args: revert.args, message: revert.message } : null, reason });
}

export function createLaunchPreparer(context: LaunchContext, reader: LaunchReader) {
  const { rpc, deployment, factory, controller, verifyDeployment, canonical } = context;
  const quote = deployment.quoteToken, chainId = deployment.chainId;

  /** The exact CCA length: the caller's `durationBlocks`, else the hours at the caller's or the sampled block rate. */
  async function durationFor(input: AuctionLaunchInput, at: Anchor) {
    const hours = input.auctionDurationHours;
    if (input.durationBlocks !== undefined) return { durationBlocks: input.durationBlocks, secondsPerBlock: input.secondsPerBlock ?? null, rateSample: null };
    const sample = input.secondsPerBlock === undefined
      ? await sampleSecondsPerBlock(rpc, { notBefore: BigInt(deployment.startBlock), blockNumber: at.blockNumber }) : null;
    const secondsPerBlock = input.secondsPerBlock ?? sample!.secondsPerBlock;
    return { durationBlocks: auctionDurationBlocks({ hours, secondsPerBlock }), secondsPerBlock, rateSample: sample };
  }
  /**
   * Resolves the launch's state on chain and prepares its next step: accept the terms, create the creator account, approve the launch fee to it, then
   * launch. Every step is simulated from the owner at the observation block. Confirm a step's receipt and prepare again with the same input: each call
   * re-reads the chain, so a confirmed step is never repeated, and a launched identity returns `stage: "complete"` with the launch read back.
   */
  async function prepareLaunch(input: AuctionLaunchInput) {
    validateAuctionLaunch(input);
    const { blockNumber, blockHash, timestamp, ...verified } = await verifyDeployment(), at: Anchor = { blockNumber, blockHash, timestamp };
    const state = await reader.stateAt(input, at);
    if (state.launched) { await canonical(at); return { ...at, ...state, stage: "complete" as const, transaction: null, owner: input.owner }; }
    check(verified.publicLaunchEnabled && !verified.entriesPaused, "LAUNCH_PAUSED", "Public launches are disabled or paused");
    check(!state.creatorAccount || !state.scheduled, "LAUNCH_ALREADY_SCHEDULED", "This creator account has a scheduled launch pending; scheduled launches are not prepared by this SDK");
    const { owner } = input, beneficiary = input.beneficiary ?? owner, fee = verified.launchFee, bond = verified.deployerBondWei, localFloor = quoteAuctionFloor(input.floorPriceWad);
    const allowanceOf = state.creatorAccount ? rpc.readContract({ address: quote.address, abi: tokenAbi, functionName: "allowance", args: [owner, state.creatorAccount], blockNumber }) : 0n;
    const [available, deal, floor, balance, nativeBalance, pending, confirmed, gasPrice, terms, allowance] = await Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "isTickerAvailable", args: [input.symbol], blockNumber }),
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [state.dealId], blockNumber }),
      rpc.readContract({ address: deployment.auctionBindings.adapter.address, abi: launchFloorAbi, functionName: "effectiveFloor", args: [input.floorPriceWad], blockNumber }),
      rpc.readContract({ address: quote.address, abi: tokenAbi, functionName: "balanceOf", args: [owner], blockNumber }),
      rpc.getBalance({ address: owner, blockNumber }), rpc.getTransactionCount({ address: owner, blockTag: "pending" }),
      rpc.getTransactionCount({ address: owner, blockTag: "latest" }), rpc.getGasPrice(),
      readTermsStatus(rpc, deployment.termsRegistry.address, owner, at), allowanceOf,
    ]);
    check(available, "TICKER_UNAVAILABLE", "The ticker is taken by an open auction or held for a scheduled launch");
    check(sameAddress(deal.creator, zeroAddress), "DEAL_ID_USED", "The deal id is already registered; do not create a new identity to retry");
    check(floor[0] === localFloor.floorPriceQ96 && floor[1] === localFloor.tickSpacingQ96, "FLOOR_MISMATCH", "The RPC's floor differs from this SDK's adapter calculation");
    check(balance >= fee, "INSUFFICIENT_QUOTE", `The creator needs the ${quote.symbol} launch fee`);
    check(nativeBalance >= bond, "INSUFFICIENT_BOND", "The creator needs the native operating bond plus gas");
    check(pending === confirmed, "PENDING_TRANSACTION", "Resolve the wallet's pending transaction before preparing again");
    check(gasPrice > 0n, "INVALID_GAS_PRICE", "The RPC must return a positive gas price");
    const needsTerms = !terms.accepted && terms.termsHash !== null;
    const approvalStages: LaunchStage[] = allowance >= fee && state.creatorAccount ? [] : allowance > 0n ? ["reset", "approve"] : ["approve"];
    const stages: LaunchStage[] = [...needsTerms ? ["terms" as const] : [], ...state.creatorAccount ? [] : ["setup" as const], ...approvalStages, "launch"];
    const stage = stages[0]!;
    let transaction: LaunchTransaction, duration: Awaited<ReturnType<typeof durationFor>> | null = null;
    if (stage === "terms") transaction = buildAcceptTerms({ chainId, termsRegistry: terms.termsRegistry, version: terms.requiredVersion, termsHash: terms.termsHash! });
    else if (stage === "setup") transaction = buildCreatorAccount({ chainId, factory, draftSalt: input.draftSalt, beneficiary });
    else if (stage === "reset" || stage === "approve") transaction = buildLaunchApprovals({ chainId, quoteToken: quote.address, creatorAccount: state.creatorAccount!, launchFee: fee, currentAllowance: allowance })[0]!;
    else {
      check(gasPrice <= verified.maxLaunchGasPrice, "GAS_PRICE_TOO_HIGH", "The gas price is above the cap the bond escrow accepts for a launch; wait for a lower gas price and prepare again");
      duration = await durationFor(input, at);
      checkDurationBlocks(input.auctionDurationHours, duration.durationBlocks);
      transaction = buildAuctionLaunch({ chainId, creatorAccount: state.creatorAccount!, name: input.name, symbol: input.symbol, floorPriceWad: input.floorPriceWad,
        creatorLockDays: input.creatorLockDays, listingCommitmentBps: input.listingCommitmentBps, auctionDurationHours: input.auctionDurationHours,
        durationBlocks: duration.durationBlocks, bondWei: bond, gasPrice });
    }
    // Simulated from the owner at the observation block, at the gas price the launch step will carry (the escrow reads `tx.gasprice`).
    const request = { to: transaction.to, data: transaction.data, value: transaction.value, account: owner, blockNumber, ...stage === "launch" ? { gasPrice } : {} };
    let simulation;
    try { simulation = await rpc.call(request); } catch (cause) { failure(stage, "simulation", cause, quote.symbol); }
    if (stage === "reset" || stage === "approve") check(simulation.data === undefined || simulation.data === "0x" || simulation.data === `0x${"0".repeat(63)}1`,
      "APPROVAL_REJECTED", "Token approval returned false or malformed data");
    let gasEstimate;
    try { gasEstimate = await rpc.estimateGas(request); } catch (cause) { failure(stage, "gas estimate", cause, quote.symbol); }
    const estimatedGasCost = ceil(gasEstimate * gasPrice * 120n, 100n);
    check(nativeBalance >= bond + estimatedGasCost, "INSUFFICIENT_GAS", "Reserve the native operating bond plus gas for this step");
    await canonical(at);
    check(await rpc.getTransactionCount({ address: owner, blockTag: "pending" }) === pending, "NONCE_CHANGED", "Wallet activity changed during preparation; prepare again");
    return { ...at, stage, stages, transaction, owner, beneficiary, dealId: state.dealId, creatorAccount: state.creatorAccount, launched: false as const,
      launchFee: fee, deployerBondWei: bond, maxLaunchGasPrice: verified.maxLaunchGasPrice, quoteBalance: balance, nativeBalance, nonce: pending, gasPrice,
      gasEstimate, estimatedGasCost, ...localFloor, simulated: true as const,
      terms: { enforced: terms.enforced, accepted: terms.accepted, requiredVersion: terms.requiredVersion, termsHash: terms.termsHash, uri: terms.uri },
      ...duration ? { durationBlocks: duration.durationBlocks, secondsPerBlock: duration.secondsPerBlock, rateSample: duration.rateSample } : {} };
  }
  return prepareLaunch;
}
