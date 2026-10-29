import { keccak256 } from "viem";
import { createOxleyAuctionClient } from "./auctions.js";
import { creatorAccountFactoryAbi, launchControllerAbi, launchEntryAbi, launchBondAbi } from "./launch-abis.js";
import { check, deploymentGeneration, sameAddress } from "./validation.js";
import type { Anchor } from "./types.js";
import type { LaunchDeployment, LaunchRpcClient } from "./launch-types.js";

export function createLaunchContext(rpc: LaunchRpcClient, deployment: LaunchDeployment, maxAge: number) {
  const auctions = createOxleyAuctionClient({ publicClient: rpc, deployment });
  const pins = deployment.launchBindings, factory = pins.creatorAccountFactory.address, controller = deployment.auctionController;
  const gen2 = deploymentGeneration(deployment) === "gen2";

  check(Number.isInteger(maxAge) && maxAge > 0 && maxAge <= 300, "INVALID_BLOCK_AGE", "Block age limit must be 1-300 seconds");
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  function fresh(at: Anchor) {
    check(at.timestamp >= now() - BigInt(maxAge) && at.timestamp <= now() + 5n,
      "STALE_BLOCK", "RPC observation is stale; prepare again using a current RPC");
  }
  async function canonical(at: Anchor) {
    fresh(at);
    check((await rpc.getBlock({ blockNumber: at.blockNumber })).hash === at.blockHash,
      "REORG", "Launch observation changed; discard and prepare again");
  }
  async function verifyDeployment() {
    const at = await auctions.verifyDeployment(); fresh(at); const blockNumber = at.blockNumber;
    for (const pin of [pins.creatorAccountFactory, pins.entryController, pins.bondEscrow]) {
      const code = await rpc.getCode({ address: pin.address, blockNumber });
      check(code && code !== "0x" && sameAddress(keccak256(code), pin.runtimeCodeHash), "CODE_MISMATCH", `Launch runtime differs at ${pin.address}`);
    }
    const [boundFactory, entry, bond, factoryController, factoryBond, bondController, fee, deposit, maxLaunchGasPrice, enabled, paused] = await Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "creatorAccountFactory", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "entryController", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "bondEscrow", blockNumber }),
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "auctionController", blockNumber }),
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "bondEscrow", blockNumber }),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "controller", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "launchFee", blockNumber }),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "CREATOR_DEPOSIT", blockNumber }),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "MAX_GAS_PRICE", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "publicLaunchEnabled", blockNumber }),
      rpc.readContract({ address: pins.entryController.address, abi: launchEntryAbi, functionName: "entriesPaused", blockNumber }),
    ]);
    check(sameAddress(boundFactory, factory) && sameAddress(entry, pins.entryController.address)
      && sameAddress(bond, pins.bondEscrow.address) && sameAddress(factoryBond, bond)
      && sameAddress(factoryController, controller) && sameAddress(bondController, controller),
    "LAUNCH_BINDING_MISMATCH", "Launch controller, factory, entry or bond binding mismatch");
    check(fee === BigInt(pins.launchFeeBaseUnits) && deposit === BigInt(pins.deployerBondWei),
      "LAUNCH_COST_MISMATCH", "On-chain launch fee or bond differs from reviewed terms");
    await canonical(at);
    return { ...at, deployment, launchFee: fee, deployerBondWei: deposit, maxLaunchGasPrice, publicLaunchEnabled: enabled, entriesPaused: paused };
  }
  return { rpc, deployment, auctions, pins, factory, controller, gen2, maxAge, canonical, verifyDeployment };
}
export type LaunchContext = ReturnType<typeof createLaunchContext>;
