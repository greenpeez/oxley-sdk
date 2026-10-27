import { encodeFunctionData } from "viem";
import { curveAbi, tokenAbi } from "./abis.js";
import { buildApprovals, buildSwap } from "./transactions.js";
import { check, sameAddress, uint } from "./validation.js";
import type { QuoteRequest, Swap } from "./types.js";
import type { ClientContext } from "./client-context.js";
import type { QuoteReader } from "./client-quotes.js";

export function createSwapPreparer(context: ClientContext, quoteReader: QuoteReader) {
  const { rpc, deployment, snapshot, assertCanonical, ensureVerified } = context;
  const { quoteAt, quote } = quoteReader;
  async function prepareSwap(request: Omit<QuoteRequest, "blockNumber"> & { slippageBps: number; ttlSeconds?: number }) {
    const ttl = request.ttlSeconds ?? 300;
    check(Number.isInteger(ttl) && ttl > 0 && ttl <= 3600, "INVALID_TTL", "Swap lifetime must be 1 to 3600 seconds");
    const quoted = await quote({ ...request, blockNumber: undefined });
    return buildSwap(quoted, { slippageBps: request.slippageBps, deadline: quoted.timestamp + BigInt(ttl) });
  }

  async function checkSwap(swap: Swap, simulate = false) {
    uint(swap.minAmountOut); uint(swap.deadline);
    check(swap.quote.chainId === deployment.chainId && swap.quote.releaseId === deployment.releaseId
      && sameAddress(swap.transaction.to, deployment.curve.address), "SWAP_MISMATCH", "Swap belongs to another deployment");
    // Reconstruct the request, rather than simulate an arbitrary target/calldata supplied by a consumer.
    const anchor = await snapshot();
    await ensureVerified(anchor);
    check(anchor.timestamp < swap.deadline, "EXPIRED_DEADLINE", "Requote the expired swap");
    const current = await quoteAt({ marketId: swap.quote.market.id, tokenIn: swap.quote.tokenIn,
      tokenOut: swap.quote.tokenOut, amountIn: swap.quote.amountIn, caller: swap.quote.caller }, anchor);
    check(current.amountOut >= swap.minAmountOut, "SLIPPAGE", "Current output is below the swap minimum");
    const expected = current.side === "buy"
      ? encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [current.market.id, current.amountIn, swap.minAmountOut, swap.deadline] })
      : encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [current.market.id, current.amountIn, swap.minAmountOut, 0n, swap.deadline] });
    check(swap.transaction.data === expected && swap.transaction.value === 0n
      && swap.transaction.chainId === deployment.chainId, "SWAP_MISMATCH", "Swap transaction does not match its quote");
    const [balance, allowance] = await Promise.all([
      rpc.readContract({ address: current.tokenIn, abi: tokenAbi, functionName: "balanceOf", args: [current.caller], blockNumber: anchor.blockNumber }),
      rpc.readContract({ address: current.tokenIn, abi: tokenAbi, functionName: "allowance", args: [current.caller, deployment.curve.address], blockNumber: anchor.blockNumber }),
    ]);
    const canonical = { ...swap, allowance: { token: current.tokenIn, owner: current.caller, spender: deployment.curve.address, amount: current.amountIn } };
    const approvals = buildApprovals(canonical, allowance);
    let gas: bigint | undefined;
    if (simulate) {
      check(balance >= current.amountIn, "INSUFFICIENT_BALANCE", "Caller needs input tokens before simulation");
      check(approvals.length === 0, "APPROVAL_REQUIRED", "Confirm required approvals before simulating the swap");
      const call = { to: deployment.curve.address, data: expected, account: current.caller, value: 0n, blockNumber: anchor.blockNumber };
      await rpc.call(call);
      gas = await rpc.estimateGas(call);
    }
    await assertCanonical(anchor);
    return { ...anchor, balance, allowance, approvals, sufficientBalance: balance >= current.amountIn, gas };
  }
  return { prepareSwap, checkSwap };
}
