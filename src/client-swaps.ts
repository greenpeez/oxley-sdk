import { tokenAbi } from "./abis.js";
import { encodeCurveTrade } from "./curve-profile.js";
import { buildApprovals, buildSwap } from "./transactions.js";
import { check, sameAddress, uint } from "./validation.js";
import type { Anchor, Quote, QuoteRequest, Swap } from "./types.js";
import type { ClientContext } from "./client-context.js";
import type { QuoteReader } from "./client-quotes.js";
import type { TermsReader } from "./client-terms.js";

export function createSwapChecker(context: ClientContext, quoteReader: QuoteReader, termsReader: TermsReader) {
  const { rpc, deployment, snapshot, assertCanonical, ensureVerified } = context;
  const { quoteAt } = quoteReader;
  /** Fails unless the swap belongs to this deployment, is unexpired and still pays at least its minimum; returns the fresh quote. */
  async function requote(swap: Swap) {
    uint(swap.minAmountOut); uint(swap.deadline);
    check(swap.quote.chainId === deployment.chainId && swap.quote.releaseId === deployment.releaseId
      && sameAddress(swap.transaction.to, deployment.curve.address), "SWAP_MISMATCH", "Swap belongs to another deployment");
    const anchor = await snapshot();
    await ensureVerified(anchor);
    check(anchor.timestamp < swap.deadline, "EXPIRED_DEADLINE", "Requote the expired swap");
    const current = await quoteAt({ marketId: swap.quote.market.id, tokenIn: swap.quote.tokenIn,
      tokenOut: swap.quote.tokenOut, amountIn: swap.quote.amountIn, caller: swap.quote.caller }, anchor);
    check(current.amountOut >= swap.minAmountOut, "SLIPPAGE", "Current output is below the swap minimum");
    return { anchor, current };
  }
  /** Balance, allowance and terms standing of the caller at the checked block. */
  async function standing(current: Quote, anchor: Anchor) {
    const [balance, allowance, terms] = await Promise.all([
      rpc.readContract({ address: current.tokenIn, abi: tokenAbi, functionName: "balanceOf", args: [current.caller], blockNumber: anchor.blockNumber }),
      rpc.readContract({ address: current.tokenIn, abi: tokenAbi, functionName: "allowance", args: [current.caller, deployment.curve.address], blockNumber: anchor.blockNumber }),
      termsReader.termsAt(current.caller, anchor),
    ]);
    return { balance, allowance, terms };
  }
  return { requote, standing, assertCanonical };
}
export type SwapChecker = ReturnType<typeof createSwapChecker>;

export function createSwapPreparer(context: ClientContext, quoteReader: QuoteReader, checker: SwapChecker) {
  const { rpc, deployment } = context;
  const { quote } = quoteReader;
  async function prepareSwap(request: Omit<QuoteRequest, "blockNumber"> & { slippageBps: number; ttlSeconds?: number }) {
    const ttl = request.ttlSeconds ?? 300;
    check(Number.isInteger(ttl) && ttl > 0 && ttl <= 3600, "INVALID_TTL", "Swap lifetime must be 1 to 3600 seconds");
    const quoted = await quote({ ...request, blockNumber: undefined });
    return buildSwap(quoted, { slippageBps: request.slippageBps, deadline: quoted.timestamp + BigInt(ttl) });
  }

  /**
   * Current price/funding checks. `termsAccepted` is true when the curve has no terms or the caller has accepted them;
   * simulation additionally requires it, because an unaccepted caller's trade reverts.
   */
  async function checkSwap(swap: Swap, simulate = false) {
    const { anchor, current } = await checker.requote(swap);
    // Reconstruct the call, rather than simulate an arbitrary target/calldata supplied by a consumer.
    const expected = encodeCurveTrade(current, swap.minAmountOut, swap.deadline);
    check(swap.transaction.data === expected && swap.transaction.value === 0n
      && swap.transaction.chainId === deployment.chainId, "SWAP_MISMATCH", "Swap transaction does not match its quote");
    const { balance, allowance, terms } = await checker.standing(current, anchor);
    const canonical = { ...swap, allowance: { token: current.tokenIn, owner: current.caller, spender: deployment.curve.address, amount: current.amountIn } };
    const approvals = buildApprovals(canonical, allowance);
    let gas: bigint | undefined;
    if (simulate) {
      check(terms.accepted, "TERMS_NOT_ACCEPTED", "The caller must accept the current terms before trading");
      check(balance >= current.amountIn, "INSUFFICIENT_BALANCE", "Caller needs input tokens before simulation");
      check(approvals.length === 0, "APPROVAL_REQUIRED", "Confirm required approvals before simulating the swap");
      const call = { to: deployment.curve.address, data: expected, account: current.caller, value: 0n, blockNumber: anchor.blockNumber };
      await rpc.call(call);
      gas = await rpc.estimateGas(call);
    }
    await checker.assertCanonical(anchor);
    return { ...anchor, balance, allowance, approvals, sufficientBalance: balance >= current.amountIn,
      termsAccepted: terms.accepted, terms, gas };
  }
  return { prepareSwap, checkSwap };
}
