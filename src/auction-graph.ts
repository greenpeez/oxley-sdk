import { keccak256, type Address } from "viem";
import { auctionControllerAbi, bidHookAbi, launchFloorCapAbi, launchMinimumRaiseAbi } from "./auction-abis.js";
import { MAX_PRICE_LEVELS, MIN_BID, TOKEN_CAP } from "./bid-rules.js";
import { MAX_FLOOR_PRICE_WAD, MINIMUM_GROSS_RAISE, MINIMUM_NET_RAISE } from "./controller-rules.js";
import { check, sameAddress } from "./validation.js";
import type { Anchor, Deployment, RpcClient } from "./types.js";

/** The controller must pin exactly the floor cap this SDK mirrors; an uncapped controller has no such getter and fails the read. */
async function verifyFloorCap(rpc: RpcClient, controller: Address, blockNumber: bigint): Promise<void> {
  const cap = await rpc.readContract({ address: controller, abi: launchFloorCapAbi, functionName: "MAX_FLOOR_PRICE_WAD", blockNumber });
  check(cap === MAX_FLOOR_PRICE_WAD, "AUCTION_BINDING_MISMATCH", "The controller's floor cap differs from the cap this SDK mirrors");
}
/** The controller's net minimum raise, and the gross figure derived from it, are the ones this SDK mirrors. Both views are immutable-backed, so they cannot change after deployment. */
async function verifyMinimumRaise(rpc: RpcClient, controller: Address, blockNumber: bigint): Promise<void> {
  const base = { address: controller, abi: launchMinimumRaiseAbi, blockNumber } as const;
  const [net, gross] = await Promise.all([rpc.readContract({ ...base, functionName: "minimumRaise" }), rpc.readContract({ ...base, functionName: "minimumGrossRaise" })]);
  check(net === MINIMUM_NET_RAISE && gross === MINIMUM_GROSS_RAISE, "AUCTION_BINDING_MISMATCH",
    `The controller's minimum raise differs from the ${new Intl.NumberFormat("en-US").format(MINIMUM_NET_RAISE / 10n ** 6n)} USDC this SDK mirrors`);
}
/**
 * The Dynamic Bids hook, its exposure helper and the terms registry must be the pinned contracts, bound to the pinned router and to each other, and the hook's
 * compiled rules must be the ones this SDK mirrors. The controller must pin the floor cap and report the 30,000 USDC net minimum raise.
 */
export async function verifyGraph(rpc: RpcClient, deployment: Deployment, at: Anchor, hook: Address): Promise<void> {
  const { bidRouter, bidHook, exposureHelper } = deployment.auctionBindings, terms = deployment.termsRegistry, controller = deployment.auctionController;
  const blockNumber = at.blockNumber, base = { address: bidHook.address, abi: bidHookAbi, blockNumber } as const;
  await Promise.all([bidHook, exposureHelper, terms].map(async pin => {
    const code = await rpc.getCode({ address: pin.address, blockNumber });
    check(code && code !== "0x" && sameAddress(keccak256(code), pin.runtimeCodeHash), "CODE_MISMATCH", `Auction runtime differs at ${pin.address}`);
  }));
  const [router, hookTerms, helper, minimum, cap, levels, controllerTerms] = await Promise.all([
    rpc.readContract({ ...base, functionName: "bidRouter" }), rpc.readContract({ ...base, functionName: "termsRegistry" }),
    rpc.readContract({ ...base, functionName: "exposureHelper" }), rpc.readContract({ ...base, functionName: "MIN_BID_AMOUNT" }),
    rpc.readContract({ ...base, functionName: "TOKEN_CAP" }), rpc.readContract({ ...base, functionName: "MAX_PRICE_LEVELS" }),
    rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "termsRegistry", blockNumber }),
  ]);
  check(sameAddress(hook, bidHook.address) && sameAddress(router, bidRouter.address) && sameAddress(hookTerms, terms.address)
    && sameAddress(helper, exposureHelper.address) && sameAddress(controllerTerms, terms.address),
  "AUCTION_BINDING_MISMATCH", "Bid hook, exposure helper or terms registry differ from the manifest");
  check(minimum === MIN_BID && cap === TOKEN_CAP && levels === BigInt(MAX_PRICE_LEVELS),
    "AUCTION_BINDING_MISMATCH", "The bid hook's compiled rules differ from the rules this SDK mirrors");
  await Promise.all([verifyFloorCap(rpc, controller, blockNumber), verifyMinimumRaise(rpc, controller, blockNumber)]);
}
