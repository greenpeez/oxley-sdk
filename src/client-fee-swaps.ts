import type { Address } from "viem";
import { tokenAbi } from "./abis.js";
import { deploymentAddresses } from "./deployment-addresses.js";
import { assembleSwapWithFee, integratorFeeAmount, validateFeeBps, validateFeeRecipient,
  type Eip5792Batch, type SwapCall, type SwapWithFee } from "./swap-fee.js";
import { minimumAmountOut } from "./transactions.js";
import { check, OxleyError, sameAddress, uint } from "./validation.js";
import type { Anchor, QuoteRequest } from "./types.js";
import type { ClientContext } from "./client-context.js";
import type { QuoteReader } from "./client-quotes.js";
import type { SwapChecker } from "./client-swaps.js";

/** `amountIn` is the user's whole input: Oxy-USDC including the fee for a buy, the coin amount for a sell. */
export type SwapFeeRequest = Omit<QuoteRequest, "blockNumber"> & {
  slippageBps: number; ttlSeconds?: number; feeRecipient: Address; feeBps: number; atomicRequired?: boolean;
};

const differs = (a: SwapCall | undefined, b: SwapCall | undefined) => !a || !b || a.kind !== b.kind || a.transaction.chainId !== b.transaction.chainId
  || a.transaction.value !== b.transaction.value || !sameAddress(a.transaction.to, b.transaction.to) || a.transaction.data !== b.transaction.data;
/** Position of the first call that differs (or -1), so a stale or altered batch is reported where it breaks. */
function firstDifference(expected: readonly SwapCall[], actual: readonly SwapCall[]): number {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) if (differs(expected[index], actual[index])) return index;
  return -1;
}
const flatBatch = (batch: Eip5792Batch) => { const [p] = batch.params;
  return [batch.method, p.version, p.from.toLowerCase(), p.chainId, String(p.atomicRequired),
    ...p.calls.flatMap(call => [call.to.toLowerCase(), call.data, call.value])].join("|"); };
const sameBatch = (a: Eip5792Batch, b: Eip5792Batch) => flatBatch(a) === flatBatch(b);

function assertSameBatch(prepared: SwapWithFee, expected: SwapWithFee): void {
  for (const calls of [prepared.calls, prepared.sequential.calls]) {
    const index = firstDifference(expected.calls, calls);
    if (index >= 0) throw new OxleyError("SWAP_MISMATCH", "The batch no longer matches its quote, fee terms or allowance; prepare it again",
      { index, expected: expected.calls[index]?.kind ?? null });
  }
  check(sameBatch(prepared.batch, expected.batch) && prepared.fee.amount === expected.fee.amount
    && prepared.spend.amount === expected.spend.amount, "SWAP_MISMATCH", "The EIP-5792 payload does not match the verified calls");
}

export function createFeeSwapPreparer(context: ClientContext, quoteReader: QuoteReader, checker: SwapChecker) {
  const { rpc, deployment } = context;
  const protocol = deploymentAddresses(deployment);
  async function prepareSwapWithFee(request: SwapFeeRequest): Promise<SwapWithFee> {
    const ttl = request.ttlSeconds ?? 300;
    check(Number.isInteger(ttl) && ttl > 0 && ttl <= 3600, "INVALID_TTL", "Swap lifetime must be 1 to 3600 seconds");
    uint(request.amountIn); validateFeeBps(request.feeBps); validateFeeRecipient(request.feeRecipient, protocol);
    // A buy spends the quote token and the curve trades what is left after the fee; a sell trades the coin and the fee follows it.
    const buy = sameAddress(request.tokenIn, deployment.quoteToken.address);
    const traded = buy ? request.amountIn - integratorFeeAmount(request.amountIn, request.feeBps) : request.amountIn;
    check(traded > 0n, "INVALID_AMOUNT", "Nothing is left to trade after the integrator fee");
    const quoted = await quoteReader.quote({ ...request, amountIn: traded, blockNumber: undefined });
    const allowance = await rpc.readContract({ address: quoted.tokenIn, abi: tokenAbi, functionName: "allowance",
      args: [quoted.caller, deployment.curve.address], blockNumber: quoted.blockNumber });
    await checker.assertCanonical(quoted);
    return assembleSwapWithFee(quoted, { feeRecipient: request.feeRecipient, feeBps: request.feeBps, forbiddenRecipients: protocol,
      amountIn: request.amountIn, minAmountOut: minimumAmountOut(quoted.amountOut, request.slippageBps),
      deadline: quoted.timestamp + BigInt(ttl), currentAllowance: allowance, atomicRequired: request.atomicRequired });
  }

  /** Simulation covers the curve trade only: an atomic batch cannot be simulated with a plain `eth_call`. */
  async function simulateTrade(expected: SwapWithFee, funding: { balance: bigint; accepted: boolean; approvals: number }, anchor: Anchor) {
    check(funding.accepted, "TERMS_NOT_ACCEPTED", "The caller must accept the current terms before trading");
    check(funding.balance >= expected.spend.amount, "INSUFFICIENT_BALANCE", "Caller needs the full input before simulation");
    check(funding.approvals === 0, "APPROVAL_REQUIRED", "Confirm required approvals before simulating the swap");
    const { to, data } = expected.swap.transaction, call = { to, data, account: expected.swap.quote.caller, value: 0n, blockNumber: anchor.blockNumber };
    await rpc.call(call);
    return rpc.estimateGas(call);
  }
  /**
   * Re-quotes and re-derives every call from the prepared parameters (market, amounts, minimum, deadline, fee terms and the
   * current allowance); any call, the EIP-5792 payload or the sequential list that differs is refused.
   */
  async function checkSwapWithFee(prepared: SwapWithFee, simulate = false) {
    const { swap } = prepared, atomicRequired = prepared.batch?.params?.[0]?.atomicRequired;
    check(typeof atomicRequired === "boolean" && prepared.sequential?.atomic === false, "SWAP_MISMATCH", "Malformed fee batch");
    const { anchor, current } = await checker.requote(swap);
    const { balance, allowance, terms } = await checker.standing(current, anchor);
    const expected = assembleSwapWithFee(current, { feeRecipient: prepared.fee.recipient, feeBps: prepared.fee.bps, forbiddenRecipients: protocol,
      amountIn: prepared.spend.amount, minAmountOut: swap.minAmountOut, deadline: swap.deadline, currentAllowance: allowance, atomicRequired });
    assertSameBatch(prepared, expected);
    const approvals = expected.calls.filter(call => call.kind.startsWith("approve")).map(call => call.transaction);
    const gas = simulate ? await simulateTrade(expected, { balance, accepted: terms.accepted, approvals: approvals.length }, anchor) : undefined;
    await checker.assertCanonical(anchor);
    return { ...anchor, balance, allowance, approvals, calls: expected.calls, fee: expected.fee, sufficientBalance: balance >= expected.spend.amount,
      termsAccepted: terms.accepted, terms, gas };
  }
  return { prepareSwapWithFee, checkSwapWithFee };
}
