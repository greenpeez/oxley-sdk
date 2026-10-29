import { keccak256 } from "viem";
import { auctionControllerAbi, auctionBidRouterAbi, auctionAdapterAbi } from "./auction-abis.js";
import { tokenAbi } from "./abis.js";
import { check, deploymentGeneration, sameAddress, address } from "./validation.js";
import { verifyGen8Graph } from "./auction-gen8-context.js";
import type { Anchor, RpcClient } from "./types.js";
import type { AuctionDeployment } from "./auctions.js";

export function createAuctionContext(rpc: RpcClient, deployment: AuctionDeployment) {
  const { bidRouter, adapter } = deployment.auctionBindings;
  const controller = deployment.auctionController;
  const generation = deploymentGeneration(deployment), gen2 = generation === "gen2", gen8 = generation === "gen8";
  async function anchor(): Promise<Anchor> {
    const [chain, block] = await Promise.all([rpc.getChainId(), rpc.getBlock({ blockTag: "latest" })]);
    check(chain === deployment.chainId, "CHAIN_MISMATCH", "RPC chain does not match deployment");
    check(block.number !== null && block.hash !== null && block.number >= BigInt(deployment.startBlock),
      "INVALID_BLOCK", "A mined block after deployment is required");
    return { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp };
  }
  async function canonical(at: Anchor) {
    check((await rpc.getBlock({ blockNumber: at.blockNumber })).hash === at.blockHash,
      "REORG", "Auction observation changed; discard and prepare again");
  }
  async function verifyAt(at: Anchor) {
    await Promise.all([bidRouter, adapter, deployment.registry, deployment.quoteToken,
      { address: controller, runtimeCodeHash: deployment.auctionBindings.controllerRuntimeCodeHash }].map(async pin => {
      const code = await rpc.getCode({ address: pin.address, blockNumber: at.blockNumber });
      check(code && code !== "0x" && sameAddress(keccak256(code), pin.runtimeCodeHash),
        "CODE_MISMATCH", `Auction runtime differs at ${pin.address}`);
    }));
    const blockNumber = at.blockNumber;
    const [router, cca, quote, registry, routerAdapter, routerQuote, adapterController, adapterQuote, hook, adapterHook, decimals] = await Promise.all([
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "feeBidRouter", blockNumber }),
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "ccaAdapter", blockNumber }),
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "quoteAsset", blockNumber }),
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "registry", blockNumber }),
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "adapter", blockNumber }),
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "quoteAsset", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "controller", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "quoteAsset", blockNumber }),
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "validationHook", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "validationHook", blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "decimals", blockNumber }),
    ]);
    check(sameAddress(router, bidRouter.address) && sameAddress(cca, adapter.address)
      && sameAddress(quote, deployment.quoteToken.address) && sameAddress(registry, deployment.registry.address)
      && sameAddress(routerAdapter, adapter.address) && sameAddress(routerQuote, quote)
      && sameAddress(adapterController, controller) && sameAddress(adapterQuote, quote)
      && sameAddress(hook, adapterHook) && decimals === 6,
    "AUCTION_BINDING_MISMATCH", "Controller, router, adapter or quote binding mismatch");
    address(hook);
    await verifyGen8Graph(rpc, deployment, at, hook);
    return hook;
  }
  return { rpc, deployment, bidRouter, adapter, controller, gen2, gen8, anchor, canonical, verifyAt };
}
export type AuctionContext = ReturnType<typeof createAuctionContext>;
