import { decodeErrorResult, formatUnits, type Hex } from "viem";
import { oxleyRevertAbi } from "./gen2-abis.js";

export type OxleyRevertName = "WalletCapExceeded" | "CreatorBidNotAllowed" | "AuctionNotRegistered" | "TradingNotOpen"
  | "ExactDurationRequired" | "InvalidDurationBlocks" | "InvalidRequestedHours";
export interface OxleyRevert {
  readonly name: OxleyRevertName;
  readonly args: readonly unknown[];
  /** Short user-facing explanation; keep `name`/`args` for programmatic handling. */
  readonly message: string;
}

/** UTC ISO time for a Unix-seconds bigint, or the raw value when it is outside the Date range. */
const isoTime = (seconds: bigint) => seconds >= 0n && seconds <= 8_640_000_000_000n
  ? new Date(Number(seconds) * 1000).toISOString().replace(/\.000Z$/, "Z") : `timestamp ${seconds}`;
export const walletCapMessage = (remaining: bigint, symbol = "USDC") => remaining > 0n
  ? `You can bid up to ${formatUnits(remaining, 6)} ${symbol} more until this auction has broad support`
  : "This wallet has reached its bid limit until this auction has broad support";
export const tradingNotOpenMessage = (fallbackAt: bigint) =>
  `Trading opens after all bids are delivered (by ${isoTime(fallbackAt)} at the latest)`;

function candidates(value: unknown, out: Hex[], depth = 0): Hex[] {
  if (typeof value === "string") {
    if (/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(value)) out.push(value as Hex);
  } else if (value && typeof value === "object" && depth < 8) {
    // viem: ContractFunctionRevertedError.raw, RawContractError.data, nested causes; EIP-1193: error.data.
    for (const key of ["raw", "data", "cause", "error"]) candidates((value as Record<string, unknown>)[key], out, depth + 1);
  }
  return out;
}
function decode(data: Hex, symbol: string, depth: number): OxleyRevert | null {
  let result;
  try { result = decodeErrorResult({ abi: oxleyRevertAbi, data }); } catch { return null; }
  const args = Object.freeze([...result.args ?? []]);
  let message: string;
  switch (result.errorName) {
    case "ValidationHookCallFailed": return depth < 2 ? decode(result.args[0], symbol, depth + 1) : null;
    case "WalletCapExceeded": message = walletCapMessage(result.args[2], symbol); break;
    case "CreatorBidNotAllowed": message = "Creators can't bid on their own auction"; break;
    case "AuctionNotRegistered": message = "This auction is not registered with the bid rules and cannot accept bids"; break;
    case "TradingNotOpen": message = tradingNotOpenMessage(result.args[1]); break;
    case "ExactDurationRequired": message = "This release needs an exact auction length in blocks; use the exact-duration launch"; break;
    case "InvalidDurationBlocks": message = `Auction length of ${result.args[0]} blocks is outside the accepted `
      + `${result.args[1]}-${result.args[2]} blocks for the requested hours (block rate outside 0.10-0.25 s)`; break;
    case "InvalidRequestedHours": message = "Auction duration must be 1-24 whole hours"; break;
    default: return null; // Solidity Error(string)/Panic(uint256) are not Oxley rule errors.
  }
  return Object.freeze({ name: result.errorName, args, message });
}

/**
 * Pure decoder for Gen2 auction/curve reverts. Accepts raw revert data or a viem/EIP-1193 error object
 * and returns null for anything else (including unrelated custom errors). Never performs RPC calls.
 */
export function decodeOxleyRevert(errorOrData: unknown, options: { quoteSymbol?: string } = {}): OxleyRevert | null {
  for (const data of candidates(errorOrData, [])) {
    const decoded = decode(data, options.quoteSymbol ?? "USDC", 0);
    if (decoded) return decoded;
  }
  return null;
}
