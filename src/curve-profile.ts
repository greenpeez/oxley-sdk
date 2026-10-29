import { encodeFunctionData, type Address, type Hex } from "viem";
import { curveAbi } from "./abis.js";
import { gen8CurveAbi } from "./gen8-abis.js";
import { deploymentGeneration } from "./validation.js";
import type { Deployment, DeploymentGeneration, Quote, RpcClient } from "./types.js";

/** Curves that check the caller against a terms registry. */
export const requiresTerms = (generation: DeploymentGeneration) => generation === "gen3" || generation === "gen8";
/** Every curve after the flat-fee release stays closed until settlement delivery completes or its timed fallback passes. */
export const hasTradingGate = (generation: DeploymentGeneration) => generation !== "flat-fee";
/** Curves whose buys pay the decaying opening surcharge. */
export const hasOpeningSurcharge = requiresTerms;

/** The curve fields every generation shares. Gen8 has no reserve asset: its reserve is always the registry's quote token. */
export interface CurveMarket {
  readonly coin: Address; readonly creator: Address; readonly activatedAt: bigint; readonly active: boolean;
  readonly reserveAsset?: Address;
}
export interface CurveQuote { readonly amountOut: bigint; readonly collateralOut: bigint; readonly feeAmount: bigint }

export async function readCurveMarket(rpc: RpcClient, deployment: Deployment, id: Hex, blockNumber: bigint): Promise<CurveMarket> {
  const address = deployment.curve.address;
  if (deploymentGeneration(deployment) === "gen8") {
    return rpc.readContract({ address, abi: gen8CurveAbi, functionName: "market", args: [id], blockNumber });
  }
  return rpc.readContract({ address, abi: curveAbi, functionName: "market", args: [id], blockNumber });
}

/** Normalizes the three quote shapes: flat-fee/Gen2/Gen3 take the account, Gen8 quotes take none and have no collateral leg. */
export async function readCurveQuote(rpc: RpcClient, deployment: Deployment,
  input: { id: Hex; side: "buy" | "sell"; amountIn: bigint; caller: Address; blockNumber: bigint }): Promise<CurveQuote> {
  const { id, side, amountIn, caller, blockNumber } = input, address = deployment.curve.address;
  if (deploymentGeneration(deployment) === "gen8") {
    const [amountOut, feeAmount] = side === "buy"
      ? await rpc.readContract({ address, abi: gen8CurveAbi, functionName: "quoteBuy", args: [id, amountIn], blockNumber })
      : await rpc.readContract({ address, abi: gen8CurveAbi, functionName: "quoteSell", args: [id, amountIn], blockNumber });
    return { amountOut, collateralOut: 0n, feeAmount };
  }
  if (side === "buy") {
    const [amountOut, feeAmount] = await rpc.readContract({ address, abi: curveAbi, functionName: "quoteBuy",
      args: [id, amountIn, caller], blockNumber });
    return { amountOut, collateralOut: 0n, feeAmount };
  }
  const [amountOut, collateralOut, feeAmount] = await rpc.readContract({ address, abi: curveAbi, functionName: "quoteSell",
    args: [id, amountIn, caller], blockNumber });
  return { amountOut, collateralOut, feeAmount };
}

/** Calldata of the curve trade. Sells have five arguments on flat-fee/Gen2/Gen3 and four on Gen8. */
export function encodeCurveTrade(quote: Pick<Quote, "side" | "amountIn" | "market">, minAmountOut: bigint, deadline: bigint): Hex {
  const { side, amountIn, market } = quote, id = market.id;
  if (market.generation === "gen8") {
    return side === "buy"
      ? encodeFunctionData({ abi: gen8CurveAbi, functionName: "buy", args: [id, amountIn, minAmountOut, deadline] })
      : encodeFunctionData({ abi: gen8CurveAbi, functionName: "sell", args: [id, amountIn, minAmountOut, deadline] });
  }
  return side === "buy"
    ? encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [id, amountIn, minAmountOut, deadline] })
    : encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [id, amountIn, minAmountOut, 0n, deadline] });
}
