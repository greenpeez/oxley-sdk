import { encodeFunctionData, toHex, zeroAddress, type Address, type Hex } from "viem";
import { tokenAbi } from "./abis.js";
import { buildApprovals, buildSwap, swapWithMinimum, validateSwapQuote } from "./transactions.js";
import { address, check, sameAddress, uint } from "./validation.js";
import type { Quote, Swap, Transaction } from "./types.js";

/** Largest integrator fee the SDK will encode: 1% of the fee basis. */
export const MAX_INTEGRATOR_FEE_BPS = 100;
export const SEQUENTIAL_FEE_WARNING = "Not atomic: every call is a separate transaction. A buy transfers the fee BEFORE the trade, so if "
  + "the trade then fails the user has already paid the fee. A sell transfers the fee AFTER the trade, so if that transfer fails the "
  + "integrator is unpaid. Use the EIP-5792 batch with atomicRequired where the wallet supports it.";

export type SwapCallKind = "fee-transfer" | "approve-reset" | "approve" | "trade";
export interface SwapCall { readonly kind: SwapCallKind; readonly transaction: Transaction }
/** The integrator's cut. Buys: `basisAmount` is the user's total spend. Sells: it is the guaranteed minimum output. */
export interface IntegratorFee {
  readonly recipient: Address; readonly bps: number; readonly token: Address; readonly amount: bigint;
  readonly basis: "input" | "minimum-output"; readonly basisAmount: bigint;
}
/** The `wallet_sendCalls` request of EIP-5792 (version 2.0.0). Pass `params[0]` to a batching wallet. */
export interface Eip5792Batch {
  readonly method: "wallet_sendCalls";
  readonly params: readonly [{ readonly version: "2.0.0"; readonly from: Address; readonly chainId: Hex; readonly atomicRequired: boolean;
    readonly calls: readonly { readonly to: Address; readonly data: Hex; readonly value: Hex }[] }];
}
export interface SwapWithFee {
  /** The curve trade alone: for a buy the net amount after the fee, for a sell the full coin amount. */
  readonly swap: Swap;
  readonly fee: IntegratorFee;
  /** Everything that leaves the wallet in total (buy: quote token including the fee; sell: the coin). */
  readonly spend: { readonly token: Address; readonly amount: bigint };
  /** Buy: coins (the fee is paid on top). Sell: quote token after the fee, from the quote and from the guaranteed minimum. */
  readonly receive: { readonly token: Address; readonly expected: bigint; readonly minimum: bigint };
  /** Ordered calls: buy = fee, approvals, trade; sell = approvals, trade, fee. A zero fee omits its transfer. */
  readonly calls: readonly SwapCall[];
  readonly batch: Eip5792Batch;
  /** The same calls as separate transactions; see {@link SEQUENTIAL_FEE_WARNING}. */
  readonly sequential: { readonly atomic: false; readonly calls: readonly SwapCall[]; readonly warning: string };
}
export interface SwapFeeTerms { feeRecipient: Address; feeBps: number; forbiddenRecipients?: readonly Address[] }
export interface SwapFeeAssembly extends SwapFeeTerms {
  /** What the user spends in total: buys include the fee; sells are the coin amount. */
  amountIn: bigint; minAmountOut: bigint; deadline: bigint; currentAllowance: bigint; atomicRequired?: boolean;
}

export function validateFeeBps(feeBps: number): void {
  check(Number.isInteger(feeBps) && feeBps >= 1 && feeBps <= MAX_INTEGRATOR_FEE_BPS,
    "INVALID_FEE_BPS", `Integrator fee must be an integer from 1 to ${MAX_INTEGRATOR_FEE_BPS} basis points`);
}
/** floor(basis * bps / 10_000): the protocol's rounding, in the payer's favor. */
export function integratorFeeAmount(basis: bigint, feeBps: number): bigint {
  uint(basis, false);
  validateFeeBps(feeBps);
  return basis * BigInt(feeBps) / 10_000n;
}
/** The recipient must be a real account: never zero, and never the curve, the tokens or any contract of the deployment. */
export function validateFeeRecipient(recipient: Address, protocol: readonly Address[]): void {
  address(recipient);
  check(!sameAddress(recipient, zeroAddress) && !protocol.some(item => sameAddress(item, recipient)),
    "INVALID_FEE_RECIPIENT", "Fee recipient must not be the zero address, the curve, a token or an Oxley protocol contract");
}
/** Splits the user's total input into the fee and the traded amount (buys), or sizes the fee from the guaranteed minimum (sells). */
export function splitSwapInput(side: "buy" | "sell", amountIn: bigint, minAmountOut: bigint, feeBps: number) {
  const basisAmount = side === "buy" ? amountIn : minAmountOut, amount = integratorFeeAmount(basisAmount, feeBps);
  return { basisAmount, amount, traded: side === "buy" ? amountIn - amount : amountIn };
}
export function eip5792Batch(calls: readonly SwapCall[], from: Address, chainId: number, atomicRequired: boolean): Eip5792Batch {
  return { method: "wallet_sendCalls", params: [{ version: "2.0.0", from, chainId: toHex(chainId), atomicRequired,
    calls: calls.map(({ transaction }) => ({ to: transaction.to, data: transaction.data, value: toHex(transaction.value) })) }] };
}

function orderedCalls(side: "buy" | "sell", swap: Swap, fee: SwapCall[], approvals: readonly Transaction[]): readonly SwapCall[] {
  const kinds: SwapCallKind[] = approvals.length === 2 ? ["approve-reset", "approve"] : ["approve"];
  const steps = approvals.map((transaction, index): SwapCall => ({ kind: kinds[index]!, transaction }));
  const trade: SwapCall = { kind: "trade", transaction: swap.transaction };
  return Object.freeze(side === "buy" ? [...fee, ...steps, trade] : [...steps, trade, ...fee]);
}
function feeCall(quote: Quote, recipient: Address, amount: bigint): SwapCall[] {
  if (amount === 0n) return [];
  return [{ kind: "fee-transfer", transaction: { chainId: quote.chainId, to: quote.market.quoteToken, value: 0n,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [recipient, amount] }) } }];
}
/** Assembles the batch from a quote and an already-fixed minimum/deadline; used for building and for re-verifying. */
export function assembleSwapWithFee(quote: Quote, input: SwapFeeAssembly): SwapWithFee {
  validateSwapQuote(quote, input.deadline);
  validateFeeRecipient(input.feeRecipient, [quote.market.curve, quote.market.quoteToken, quote.market.coin, ...input.forbiddenRecipients ?? []]);
  uint(input.amountIn); uint(input.minAmountOut); uint(input.currentAllowance, false);
  const { side } = quote, { basisAmount, amount, traded } = splitSwapInput(side, input.amountIn, input.minAmountOut, input.feeBps);
  check(traded > 0n && traded === quote.amountIn, "SWAP_MISMATCH", "The quote does not match the traded amount after the fee");
  const swap = swapWithMinimum(quote, input.minAmountOut, input.deadline);
  const calls = orderedCalls(side, swap, feeCall(quote, input.feeRecipient, amount), buildApprovals(swap, input.currentAllowance));
  const fee: IntegratorFee = Object.freeze({ recipient: input.feeRecipient, bps: input.feeBps, token: quote.market.quoteToken, amount,
    basis: side === "buy" ? "input" : "minimum-output", basisAmount });
  const deducted = side === "sell" ? amount : 0n;
  return Object.freeze({ swap, fee, calls, spend: Object.freeze({ token: quote.tokenIn, amount: input.amountIn }),
    receive: Object.freeze({ token: quote.tokenOut, expected: quote.amountOut - deducted, minimum: input.minAmountOut - deducted }),
    batch: eip5792Batch(calls, quote.caller, quote.chainId, input.atomicRequired ?? true),
    sequential: Object.freeze({ atomic: false as const, calls, warning: SEQUENTIAL_FEE_WARNING }) });
}
/**
 * Offline builder. `quote` must be for the traded amount: the net input after the fee for a buy, the coin amount for a sell.
 * Prefer the client's `prepareSwapWithFee`, which sizes the quote itself and reads the current allowance.
 */
export function buildSwapWithFee(quote: Quote, options: Omit<SwapFeeAssembly, "minAmountOut"> & { slippageBps: number }): SwapWithFee {
  const { minAmountOut } = buildSwap(quote, { slippageBps: options.slippageBps, deadline: options.deadline });
  return assembleSwapWithFee(quote, { ...options, minAmountOut });
}
