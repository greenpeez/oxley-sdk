import { zeroAddress } from "viem";
import { registryAbi, tokenAbi } from "./abis.js";
import { launchControllerAbi, launchFloorAbi } from "./launch-abis.js";
import { check, sameAddress } from "./validation.js";
import { EXACT_ONLY, exactDuration } from "./launch-duration.js";
import { quoteAuctionFloor, validateAuctionLaunch } from "./launch-input.js";
import { prepareLaunchStep, type LaunchStep } from "./launch-transactions.js";
import type { AuctionLaunchInput, AuctionLaunchTransaction } from "./launch-types.js";
import type { LaunchContext } from "./launch-context.js";
import type { LaunchReader, LaunchState } from "./launch-account.js";

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
async function simulateLaunchStep(context: LaunchContext, input: AuctionLaunchInput, state: LaunchState, step: LaunchStep, gasPrice: bigint) {
  const { rpc } = context, { stage } = step;
  const blockNumber = state.blockNumber;
  check(gasPrice > 0n, "INVALID_GAS_PRICE", "RPC must return a positive gas price");
  check(stage !== "launch" || gasPrice <= state.maxLaunchGasPrice,
    "GAS_PRICE_TOO_HIGH", "Current gas price exceeds the bond contract's launch cap; wait and prepare again");
  const transaction: AuctionLaunchTransaction = { ...step.transaction, gasPrice };
  const simulation = await rpc.call({ ...transaction, account: input.owner, blockNumber });
  if (stage === "approve" || stage === "reset") check(simulation.data === undefined || simulation.data === "0x"
    || simulation.data === `0x${"0".repeat(63)}1`, "APPROVAL_REJECTED", "Token approval returned false or malformed data");
  const gasEstimate = await rpc.estimateGas({ ...transaction, account: input.owner, blockNumber });
  const estimatedGasCost = ceil(gasEstimate * gasPrice * 120n, 100n);
  return { transaction, gasEstimate, estimatedGasCost };
}
export function createLaunchPreparer(context: LaunchContext, launchReader: LaunchReader) {
  const { rpc, deployment, controller, gen2, maxAge, canonical } = context;
  const { getLaunch } = launchReader;
  async function prepareLaunch(input: AuctionLaunchInput) {
    validateAuctionLaunch(input);
    check(gen2 || (input.secondsPerBlock === undefined && input.durationBlocks === undefined), "EXACT_DURATION_UNSUPPORTED", EXACT_ONLY);
    const state = await getLaunch(input);
    if (state.launched) return { ...state, stage: "complete" as const, transaction: null };
    check(state.publicLaunchEnabled && !state.entriesPaused, "LAUNCH_PAUSED", "Public launches are disabled or paused");
    const blockNumber = state.blockNumber, localFloor = quoteAuctionFloor(input.floorPriceWad);
    const [reads, duration] = await Promise.all([Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "isTickerAvailable", args: [input.symbol], blockNumber }),
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [input.dealId], blockNumber }),
      rpc.readContract({ address: deployment.auctionBindings.adapter.address, abi: launchFloorAbi, functionName: "effectiveFloor", args: [input.floorPriceWad], blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "balanceOf", args: [input.owner], blockNumber }),
      rpc.getBalance({ address: input.owner, blockNumber }),
      rpc.getTransactionCount({ address: input.owner, blockTag: "pending" }),
      rpc.getTransactionCount({ address: input.owner, blockTag: "latest" }), rpc.getGasPrice(),
    ]), gen2 ? exactDuration(rpc, deployment, input, state) : null]);
    const [available, deal, floor, balance, nativeBalance, pending, confirmed, gasPrice] = reads;
    check(available, "TICKER_UNAVAILABLE", "Ticker is already in use");
    check(sameAddress(deal.creator, zeroAddress), "DEAL_ID_USED", "Deal ID is already in use; do not create a new identity to retry");
    check(floor[0] === localFloor.floorPriceQ96 && floor[1] === localFloor.tickSpacingQ96,
      "FLOOR_MISMATCH", "RPC floor differs from local adapter calculation");
    check(balance >= state.launchFee, "INSUFFICIENT_QUOTE", "Creator needs the USDC launch fee");
    check(nativeBalance >= state.deployerBondWei, "INSUFFICIENT_BOND", "Creator needs the native operating bond plus gas");
    check(pending === confirmed, "PENDING_TRANSACTION", "Resolve the wallet's pending transaction before preparing again");
    const step = await prepareLaunchStep(context, input, state, duration);
    const { stage } = step;
    const { transaction, gasEstimate, estimatedGasCost } = await simulateLaunchStep(context, input, state, step, gasPrice);
    check(nativeBalance >= state.deployerBondWei + estimatedGasCost, "INSUFFICIENT_GAS", "Reserve the operating bond plus gas for this step");
    await canonical(state);
    check(await rpc.getTransactionCount({ address: input.owner, blockTag: "pending" }) === pending,
      "NONCE_CHANGED", "Wallet activity changed during preparation; prepare again");
    return { ...state, stage, transaction, owner: input.owner, ...localFloor, quoteBalance: balance, nativeBalance,
      nonce: pending, gasEstimate, estimatedGasCost, expiresAt: state.timestamp + BigInt(maxAge), simulated: true as const,
      ...(duration ?? {} as Partial<NonNullable<typeof duration>>) };
  }
  return prepareLaunch;
}
