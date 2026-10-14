import { encodeFunctionData, parseAbi } from "viem";
import { check } from "./validation.js";
import type { Swap } from "./types.js";

export const zeroExBasicAbi = parseAbi([
  "function BASIC(address sellToken,uint256 ppm,address pool,uint256 offset,bytes data)",
]);

/** One action for the provider's existing route; NOT a complete 0x user transaction. */
export function buildZeroExBasic(swap: Swap, proportionPpm = 1_000_000) {
  check(Number.isSafeInteger(proportionPpm) && proportionPpm > 0 && proportionPpm <= 1_000_000,
    "INVALID_PROPORTION", "BASIC proportion must be 1 to 1000000 ppm");
  return {
    data: encodeFunctionData({ abi: zeroExBasicAbi, functionName: "BASIC", args: [
      swap.quote.tokenIn, BigInt(proportionPpm), swap.transaction.to, 36n, swap.transaction.data,
    ] }),
    sellToken: swap.quote.tokenIn, pool: swap.transaction.to, amountInOffset: 36 as const,
    expectedCaller: swap.quote.caller, expectedAmountIn: swap.quote.amountIn,
  };
}
