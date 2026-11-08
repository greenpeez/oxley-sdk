import { keccak256 } from "viem";
import { createAuctionContext } from "./auction-context.js";
import { creatorAccountFactoryAbi, launchBondAbi, launchControllerAbi, launchEntryAbi } from "./launch-abis.js";
import { AUCTION_MAX_BLOCKS_PER_HOUR, AUCTION_MIN_BLOCKS_PER_HOUR } from "./launch-duration.js";
import { check, sameAddress } from "./validation.js";
import type { Deployment } from "./types.js";
import type { LaunchRpcClient } from "./launch-types.js";

/** The auction graph's verification plus the launch contracts: pins, bindings to each other, the launch fee and bond, the duration bounds and whether launches are open. */
export function createLaunchContext(rpc: LaunchRpcClient, deployment: Deployment) {
  const auctions = createAuctionContext(rpc, deployment);
  const pins = deployment.launchBindings, factory = pins.creatorAccountFactory.address, controller = deployment.auctionController;
  const { anchor, canonical } = auctions;
  async function verifyDeployment() {
    const at = await anchor(), blockNumber = at.blockNumber;
    await auctions.verifyAt(at);
    await Promise.all([pins.creatorAccountFactory, pins.entryController, pins.bondEscrow].map(async pin => {
      const code = await rpc.getCode({ address: pin.address, blockNumber });
      check(code && code !== "0x" && sameAddress(keccak256(code), pin.runtimeCodeHash), "CODE_MISMATCH", `Launch runtime differs at ${pin.address}`);
    }));
    const bond = pins.bondEscrow.address, entry = pins.entryController.address;
    const [boundFactory, boundEntry, boundBond, factoryController, factoryBond, bondController, fee, deposit, maxLaunchGasPrice, enabled, paused, shortest, longest] = await Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "creatorAccountFactory", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "entryController", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "bondEscrow", blockNumber }),
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "auctionController", blockNumber }),
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "bondEscrow", blockNumber }),
      rpc.readContract({ address: bond, abi: launchBondAbi, functionName: "controller", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "launchFee", blockNumber }),
      rpc.readContract({ address: bond, abi: launchBondAbi, functionName: "CREATOR_DEPOSIT", blockNumber }),
      rpc.readContract({ address: bond, abi: launchBondAbi, functionName: "MAX_GAS_PRICE", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "publicLaunchEnabled", blockNumber }),
      rpc.readContract({ address: entry, abi: launchEntryAbi, functionName: "entriesPaused", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "durationBounds", args: [1], blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "durationBounds", args: [24], blockNumber }),
    ]);
    check(sameAddress(boundFactory, factory) && sameAddress(boundEntry, entry) && sameAddress(boundBond, bond) && sameAddress(factoryBond, bond)
      && sameAddress(factoryController, controller) && sameAddress(bondController, controller),
    "LAUNCH_BINDING_MISMATCH", "Launch controller, factory, entry controller or bond escrow binding mismatch");
    check(fee === BigInt(pins.launchFeeBaseUnits) && deposit === BigInt(pins.deployerBondWei),
      "LAUNCH_COST_MISMATCH", "The on-chain launch fee or operating bond differs from the reviewed terms");
    check(shortest[0] === AUCTION_MIN_BLOCKS_PER_HOUR && shortest[1] === AUCTION_MAX_BLOCKS_PER_HOUR
      && longest[0] === 24 * AUCTION_MIN_BLOCKS_PER_HOUR && longest[1] === 24 * AUCTION_MAX_BLOCKS_PER_HOUR,
    "DURATION_BOUNDS_MISMATCH", "The controller's auction duration bounds differ from this SDK; do not launch against this release");
    await canonical(at);
    return { deployment, ...at, launchFee: fee, deployerBondWei: deposit, maxLaunchGasPrice, publicLaunchEnabled: enabled, entriesPaused: paused };
  }
  return { rpc, deployment, auctions, pins, factory, controller, anchor, canonical, verifyDeployment };
}
export type LaunchContext = ReturnType<typeof createLaunchContext>;
