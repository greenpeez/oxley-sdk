import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyClient } from "@oxley/sdk";

// The provider owns transport and signing; no Oxley API key or server is required.
export async function prepare(deployment: unknown, rpcUrl: string, marketId: Hex,
  tokenIn: Address, tokenOut: Address, amountIn: bigint, caller: Address) {
  const sdk = createOxleyClient({ deployment, publicClient: createPublicClient({ transport: http(rpcUrl) }) });
  const swap = await sdk.prepareSwap({ marketId, tokenIn, tokenOut, amountIn, caller, slippageBps: 50 });
  const funding = await sdk.checkSwap(swap);
  // Submit funding.approvals in order with the caller's wallet, wait for receipts,
  // then prepare a fresh swap and checkSwap(freshSwap, true) before submitting.
  return { swap, approvals: funding.approvals };
}
