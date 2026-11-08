import { encodeFunctionData, type Address, type Hex } from "viem";
import { curveAbi } from "./curve-abis.js";
import type { Deployment, Quote, RpcClient } from "./types.js";

/** The curve fields the SDK reads. The curve has no reserve asset: its reserve is always the registry's quote token. */
export interface CurveMarket { readonly coin: Address; readonly creator: Address; readonly activatedAt: bigint; readonly active: boolean }
export interface CurveQuote { readonly amountOut: bigint; readonly feeAmount: bigint }

export async function readCurveMarket(rpc: RpcClient, deployment: Deployment, id: Hex, blockNumber: bigint): Promise<CurveMarket> {
  return rpc.readContract({ address: deployment.curve.address, abi: curveAbi, functionName: "market", args: [id], blockNumber });
}

/** Quote views take no account argument: the fee a trade pays does not depend on who calls. */
export async function readCurveQuote(rpc: RpcClient, deployment: Deployment,
  input: { id: Hex; side: "buy" | "sell"; amountIn: bigint; blockNumber: bigint }): Promise<CurveQuote> {
  const { id, side, amountIn, blockNumber } = input, address = deployment.curve.address;
  const [amountOut, feeAmount] = side === "buy"
    ? await rpc.readContract({ address, abi: curveAbi, functionName: "quoteBuy", args: [id, amountIn], blockNumber })
    : await rpc.readContract({ address, abi: curveAbi, functionName: "quoteSell", args: [id, amountIn], blockNumber });
  return { amountOut, feeAmount };
}

/** Calldata of the curve trade: `buy` and `sell` both take (market, amount in, minimum out, deadline). */
export function encodeCurveTrade(quote: Pick<Quote, "side" | "amountIn" | "market">, minAmountOut: bigint, deadline: bigint): Hex {
  const { side, amountIn, market } = quote, id = market.id;
  return side === "buy"
    ? encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [id, amountIn, minAmountOut, deadline] })
    : encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [id, amountIn, minAmountOut, deadline] });
}
