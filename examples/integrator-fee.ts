import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyMarkets } from "@oxley/sdk";

// A buy that pays the integrator 0.5% on top of the protocol's fees, as one EIP-5792 batch.
export async function buyWithFee(rpcUrl: string, dealId: Hex, wallet: Address, treasury: Address, spend: bigint) {
  const markets = createOxleyMarkets({ publicClient: createPublicClient({ transport: http(rpcUrl) }) });
  const { market } = await markets.resolveMarket(dealId);
  const prepared = await markets.prepareSwapWithFee({ marketId: dealId, tokenIn: market.quoteToken, tokenOut: market.coin,
    amountIn: spend, caller: wallet, slippageBps: 100, feeRecipient: treasury, feeBps: 50 });
  // Show prepared.fee.amount and prepared.receive.minimum to the user, then re-verify every call just before sending.
  await markets.checkSwapWithFee(prepared);
  // Wallets with batching: provider.request(prepared.batch). Otherwise send prepared.sequential.calls one by one,
  // waiting for each receipt, and tell the user prepared.sequential.warning first.
  return prepared;
}
