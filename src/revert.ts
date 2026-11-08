import { decodeErrorResult, formatUnits, type Hex } from "viem";
import { launchFloorCapAbi, oxleyRevertAbi } from "./auction-abis.js";

export type OxleyRevertName = "WalletCapExceeded" | "CreatorBidNotAllowed" | "TradingNotOpen"
  | "TermsNotAccepted" | "BuysPaused" | "MinimumNotMet"
  | "DeadlineExpired" | "QuoteDust" | "CapitalShortfall" | "WalletBidLimitReached" | "BidAmountTooLow" | "PriceLevelLimit"
  | "BidPriceTooHigh" | "InvalidWitness" | "BidExpired" | "NotBidOwner" | "BidNotOutbid" | "RebidPriceTooLow" | "FloorPriceAboveMaximum";
export interface OxleyRevert {
  readonly name: OxleyRevertName;
  readonly args: readonly unknown[];
  /** Short user-facing explanation; keep `name`/`args` for programmatic handling. */
  readonly message: string;
}

/** UTC ISO time for a Unix-seconds bigint, or the raw value when it is outside the Date range. */
const isoTime = (seconds: bigint) => seconds >= 0n && seconds <= 8_640_000_000_000n
  ? new Date(Number(seconds) * 1000).toISOString().replace(/\.000Z$/, "Z") : `timestamp ${seconds}`;
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
/** The rule errors plus the launch controller's floor cap error, which has no compiled ABI in this package. */
const revertAbi = [...oxleyRevertAbi, ...launchFloorCapAbi] as const;
function decodeResult(data: Hex) {
  try { return decodeErrorResult({ abi: revertAbi, data }); } catch { return null; }
}
type Args = readonly unknown[];
interface RevertContext { symbol: string }
/** The wallet's own commitment ceiling or token cap. */
const capMessage = (remaining: bigint, symbol: string) => remaining > 0n
  ? `You can bid up to ${formatUnits(remaining, 6)} ${symbol} more on this auction` : "This wallet has reached its limit on this auction";
const MESSAGES: Partial<Record<OxleyRevertName, (args: Args, context: RevertContext) => string>> = {
  WalletCapExceeded: (args, { symbol }) => capMessage(args[2] as bigint, symbol),
  CreatorBidNotAllowed: () => "Creators can't bid on their own auction",
  TradingNotOpen: args => tradingNotOpenMessage(args[1] as bigint),
  TermsNotAccepted: () => "The wallet must accept the current Oxley terms before trading or bidding",
  BuysPaused: () => "Buying is paused on this curve; selling stays available",
  MinimumNotMet: () => "The trade would pay less than your minimum; requote or raise your slippage tolerance",
  DeadlineExpired: () => "The trade deadline has passed; prepare it again",
  QuoteDust: () => "This amount cannot be filled exactly on the curve; try a different amount",
  CapitalShortfall: () => "The curve cannot fill this amount right now",
  WalletBidLimitReached: args => `This wallet has reached the limit of ${args[1]} ${args[1] === 3n ? "live" : "total"} bids on this auction`,
  BidAmountTooLow: () => "Minimum bid is 20 Oxy-USDC",
  PriceLevelLimit: () => "Too many price levels are open; bid at a price that already has bids, or try again shortly",
  BidPriceTooHigh: () => "The bid price is above the auction's maximum",
  InvalidWitness: () => "The checkpoint hints for this wallet's bids are stale; prepare the bid again",
  BidExpired: () => "The bid deadline has passed; prepare it again",
  NotBidOwner: () => "Only the bid's owner can rebid it",
  BidNotOutbid: () => "Only an outbid bid can be rebid",
  RebidPriceTooLow: () => "A rebid must be priced above the current clearing price",
  // Owner-supplied signature FloorPriceAboveMaximum(uint256,uint256): args are the requested floor and the maximum, both in floorPriceWad units.
  FloorPriceAboveMaximum: (args, { symbol }) => `The ${symbol} floor price is above the maximum this release allows; use a floor of at most ${args[1]} (floorPriceWad units)`,
};
function explainRevert(result: NonNullable<ReturnType<typeof decodeResult>>, context: RevertContext): OxleyRevert | null {
  const name = result.errorName as OxleyRevertName, explain = MESSAGES[name];
  // Solidity Error(string)/Panic(uint256) and the wrapper itself are not Oxley rule errors.
  if (!explain) return null;
  const args = Object.freeze([...result.args ?? []]);
  return Object.freeze({ name, args, message: explain(args, context) });
}
function decode(data: Hex, context: RevertContext, depth: number): OxleyRevert | null {
  const result = decodeResult(data);
  if (!result) return null;
  if (result.errorName === "ValidationHookCallFailed") {
    return depth < 2 ? decode(result.args[0], context, depth + 1) : null;
  }
  return explainRevert(result, context);
}
/**
 * Pure decoder for Oxley rule reverts (terms, curve trades and the trading gate, Dynamic Bids and rebids, and the launch floor cap). Accepts raw
 * revert data or a viem/EIP-1193 error object and returns null for anything else (including unrelated custom errors). Never performs RPC calls.
 */
export function decodeOxleyRevert(errorOrData: unknown, options: { quoteSymbol?: string } = {}): OxleyRevert | null {
  for (const data of candidates(errorOrData, [])) {
    const decoded = decode(data, { symbol: options.quoteSymbol ?? "USDC" }, 0);
    if (decoded) return decoded;
  }
  return null;
}
