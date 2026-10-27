import { encodeFunctionData, type Address, type Hex } from "viem";
import { tokenAbi } from "./abis.js";
import { creatorAccountAbi, creatorAccountFactoryAbi } from "./launch-abis.js";
import { gen2CreatorAccountAbi } from "./gen2-abis.js";
import { address, check, deploymentGeneration, hash } from "./validation.js";
import { parseLaunchDeployment } from "./launch-deployment.js";
import { validateAuctionLaunch } from "./launch-input.js";
import { EXACT_ONLY, launchDurationBlocks, type LaunchDuration } from "./launch-duration.js";
import type { Transaction } from "./types.js";
import type { AuctionLaunchInput, AuctionLaunchTransaction } from "./launch-types.js";
import type { LaunchContext } from "./launch-context.js";
import type { LaunchState } from "./launch-account.js";

export function buildCreatorAccount(input: { deployment: unknown; owner: Address; dealId: Hex }): Transaction {
  const d = parseLaunchDeployment(input.deployment); address(input.owner); hash(input.dealId);
  return { chainId: d.chainId, to: d.launchBindings.creatorAccountFactory.address, value: 0n,
    data: encodeFunctionData({ abi: creatorAccountFactoryAbi, functionName: "createAccount", args: [input.dealId, input.owner] }) };
}
/** Flat-fee: hours-only method, unchanged. Gen2: exact-duration method; needs secondsPerBlock or durationBlocks. */
export function buildAuctionLaunch(input: AuctionLaunchInput & { deployment: unknown; creatorAccount: Address }): AuctionLaunchTransaction {
  const d = parseLaunchDeployment(input.deployment); validateAuctionLaunch(input); address(input.creatorAccount);
  if (deploymentGeneration(d) === "gen2") {
    return { chainId: d.chainId, to: input.creatorAccount, value: BigInt(d.launchBindings.deployerBondWei),
      data: encodeFunctionData({ abi: gen2CreatorAccountAbi, functionName: "launchAuctionWithCommitmentAndExactDuration",
        args: [input.name, input.symbol, input.floorPriceWad, input.creatorLockDays, input.listingCommitmentBps,
          input.auctionDurationHours, launchDurationBlocks(input)] }) };
  }
  check(input.secondsPerBlock === undefined && input.durationBlocks === undefined, "EXACT_DURATION_UNSUPPORTED", EXACT_ONLY);
  return { chainId: d.chainId, to: input.creatorAccount, value: BigInt(d.launchBindings.deployerBondWei),
    data: encodeFunctionData({ abi: creatorAccountAbi, functionName: "launchAuctionWithCommitmentAndDuration",
      args: [input.name, input.symbol, input.floorPriceWad, input.creatorLockDays, input.listingCommitmentBps, input.auctionDurationHours] }) };
}

export type LaunchStep = { stage: "setup" | "reset" | "approve" | "launch"; transaction: AuctionLaunchTransaction };
export async function prepareLaunchStep(context: LaunchContext, input: AuctionLaunchInput, state: LaunchState, duration: LaunchDuration): Promise<LaunchStep> {
  const { rpc, deployment } = context;
  let stage: LaunchStep["stage"] = "setup";
  let transaction: AuctionLaunchTransaction = buildCreatorAccount({ deployment, owner: input.owner, dealId: input.dealId });
  if (state.creatorAccount) {
    const allowance = await rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi,
      functionName: "allowance", args: [input.owner, state.creatorAccount], blockNumber: state.blockNumber });
    stage = allowance >= state.launchFee ? "launch" : allowance === 0n ? "approve" : "reset";
    transaction = stage === "launch" ? buildAuctionLaunch({ ...input, deployment, creatorAccount: state.creatorAccount,
      ...(duration ? { durationBlocks: duration.durationBlocks } : {}) })
      : { chainId: deployment.chainId, to: deployment.quoteToken.address, value: 0n,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [state.creatorAccount, stage === "reset" ? 0n : state.launchFee] }) };
  }
  return { stage, transaction };
}
