import { keccak256 } from "viem";
import { gen8BidHookAbi } from "./gen8-abis.js";
import { openingFeeCurveAbi } from "./gen3-abis.js";
import { GEN8_MAX_PRICE_LEVELS, GEN8_MIN_BID, GEN8_TOKEN_CAP } from "./gen8-bid-rules.js";
import { check, deploymentGeneration, sameAddress } from "./validation.js";
import type { Address } from "viem";
import type { Anchor, RpcClient } from "./types.js";
import type { AuctionDeployment } from "./auctions.js";

/**
 * Gen8 only (a no-op for other generations): the Dynamic Bids hook, its exposure helper and the terms registry must be the pinned contracts, bound to the pinned
 * router and to each other, and the hook's compiled rules must be the ones this SDK mirrors.
 */
export async function verifyGen8Graph(rpc: RpcClient, deployment: AuctionDeployment, at: Anchor, hook: Address): Promise<void> {
  if (deploymentGeneration(deployment) !== "gen8") return;
  const { bidRouter, bidHook, exposureHelper } = deployment.auctionBindings, terms = deployment.termsRegistry;
  check(bidHook && exposureHelper && terms, "AUCTION_BINDINGS_REQUIRED", "Gen8 needs the bid hook, exposure helper and terms registry pins");
  const blockNumber = at.blockNumber, base = { address: bidHook.address, abi: gen8BidHookAbi, blockNumber } as const;
  await Promise.all([bidHook, exposureHelper, terms].map(async pin => {
    const code = await rpc.getCode({ address: pin.address, blockNumber });
    check(code && code !== "0x" && sameAddress(keccak256(code), pin.runtimeCodeHash), "CODE_MISMATCH", `Auction runtime differs at ${pin.address}`);
  }));
  const [router, hookTerms, helper, minimum, cap, levels, controllerTerms] = await Promise.all([
    rpc.readContract({ ...base, functionName: "bidRouter" }), rpc.readContract({ ...base, functionName: "termsRegistry" }),
    rpc.readContract({ ...base, functionName: "exposureHelper" }), rpc.readContract({ ...base, functionName: "MIN_BID_AMOUNT" }),
    rpc.readContract({ ...base, functionName: "TOKEN_CAP" }), rpc.readContract({ ...base, functionName: "MAX_PRICE_LEVELS" }),
    rpc.readContract({ address: deployment.auctionController, abi: openingFeeCurveAbi, functionName: "termsRegistry", blockNumber }),
  ]);
  check(sameAddress(hook, bidHook.address) && sameAddress(router, bidRouter.address) && sameAddress(hookTerms, terms.address)
    && sameAddress(helper, exposureHelper.address) && sameAddress(controllerTerms, terms.address),
  "AUCTION_BINDING_MISMATCH", "Bid hook, exposure helper or terms registry differ from the manifest");
  check(minimum === GEN8_MIN_BID && cap === GEN8_TOKEN_CAP && levels === BigInt(GEN8_MAX_PRICE_LEVELS),
    "AUCTION_BINDING_MISMATCH", "The bid hook's compiled rules differ from the rules this SDK mirrors");
}
