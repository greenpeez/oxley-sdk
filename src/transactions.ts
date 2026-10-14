import { encodeFunctionData } from "viem";
import { curveAbi, tokenAbi } from "./abis.js";
import { address, check, hash, uint } from "./validation.js";
import type { Quote, Swap, Transaction } from "./types.js";

export function minimumAmountOut(amountOut: bigint, slippageBps: number): bigint {
  uint(amountOut);
  check(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps < 10_000,
    "INVALID_SLIPPAGE", "Slippage must be an integer from 0 to 9999 basis points");
  const minimum = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
  check(minimum > 0n, "DUST_MINIMUM", "Slippage rounds minimum output to zero");
  return minimum;
}

/** Pure encoder. Use prepareSwap for a fresh, RPC-validated quote. */
export function buildSwap(quote: Quote, options: { slippageBps: number; deadline: bigint }): Swap {
  uint(quote.amountIn); uint(quote.amountOut); hash(quote.market.id);
  address(quote.caller); address(quote.market.curve); uint(options.deadline);
  check(quote.side === "buy" || quote.side === "sell", "INVALID_SIDE", "Swap side must be buy or sell");
  check(Number.isSafeInteger(quote.chainId) && quote.chainId > 0, "INVALID_CHAIN", "Swap chain ID required");
  check(options.deadline > quote.timestamp, "EXPIRED_DEADLINE", "Deadline must be later than the quote block");
  const minAmountOut = minimumAmountOut(quote.amountOut, options.slippageBps);
  const data = quote.side === "buy"
    ? encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [quote.market.id, quote.amountIn, minAmountOut, options.deadline] })
    : encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [quote.market.id, quote.amountIn, minAmountOut, 0n, options.deadline] });
  return Object.freeze({ quote, transaction: { chainId: quote.chainId, to: quote.market.curve, data, value: 0n as const },
    allowance: { token: quote.tokenIn, owner: quote.caller, spender: quote.market.curve, amount: quote.amountIn },
    minAmountOut, deadline: options.deadline, amountInOffset: 36,
    outputReceiver: quote.caller, rewardBeneficiary: quote.caller });
}

/** Exact approvals; zero-first avoids nonzero-to-nonzero allowance incompatibility. */
export function buildApprovals(swap: Swap, currentAllowance: bigint): readonly Transaction[] {
  uint(currentAllowance, false);
  const { token, spender, amount } = swap.allowance;
  address(token); address(spender); uint(amount);
  if (currentAllowance >= amount) return [];
  return (currentAllowance > 0n ? [0n, amount] : [amount]).map(value => ({
    chainId: swap.transaction.chainId, to: token, value: 0n,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, value] }),
  }));
}
