import { maxUint128 } from "viem";
import { check, uint } from "./validation.js";

/**
 * Per-wallet rules of the Gen8 bid hook, mirrored for display and pre-checks; the hook is the authority and the manifest's
 * `bidRules` plus the hook's getters are verified against these constants. Amounts are Oxy-USDC base units unless noted.
 */
export const GEN8_MIN_BID = 20_000_000n;
/** Tokens (18 decimals) one wallet may hold from one auction. */
export const GEN8_TOKEN_CAP = 30_000_000n * 10n ** 18n;
export const GEN8_MAX_LIVE_BIDS = 3;
export const GEN8_MAX_WALLET_BIDS = 12;
export const GEN8_MAX_PRICE_LEVELS = 1000;
/** Accepted-bid fee, charged on top of the entered principal and rounded down. */
export const ACCEPTED_BID_FEE_BPS = 10n;
/** The manifest's `bidRules` record: every field is an exact compiled value. */
export const GEN8_BID_RULES = { version: "8", minBid: "20000000", tokenCap: "30000000000000000000000000", liveBids: 3, walletBids: 12,
  hookMaxBids: 0, capacityMaxBids: 0, maxPriceLevels: 1000 } as const;

const Q96 = 1n << 96n;
export const acceptedBidFee = (entered: bigint): bigint => entered * ACCEPTED_BID_FEE_BPS / 10_000n;
/** Total debit of a bid: the principal plus the accepted-bid fee. */
export const bidDebit = (entered: bigint): bigint => entered + acceptedBidFee(entered);
/** Largest principal whose debit fits `balance`. */
export function affordableBid(balance: bigint): bigint {
  uint(balance, false);
  const principal = ((balance + 1n) * 10_000n - 1n) / (10_000n + ACCEPTED_BID_FEE_BPS);
  return principal < maxUint128 ? principal : maxUint128;
}
/** A wallet's commitment ceiling on one auction: max(ceil(minimum gross raise / 10), what all other wallets committed / 9). */
export function walletCeiling(minimumGrossRaise: bigint, otherCommitted: bigint): bigint {
  const floor = (minimumGrossRaise + 9n) / 10n, relative = otherCommitted / 9n;
  return floor > relative ? floor : relative;
}
/** How much principal a new bid may add: headroom under the ceiling, limited by the wallet's remaining token cap at the clearing price. */
export function walletAllowance(input: { ceiling: bigint; committed: bigint; tokensHeld: bigint; clearingPriceQ96: bigint }): bigint {
  const headroom = input.ceiling > input.committed ? input.ceiling - input.committed : 0n;
  const tokens = GEN8_TOKEN_CAP > input.tokensHeld ? (GEN8_TOKEN_CAP - input.tokensHeld) * input.clearingPriceQ96 / Q96 : 0n;
  return headroom < tokens ? headroom : tokens;
}

/** One bid of the wallet as the hook counts it. `outbid` means its max price is below the clearing price. */
export interface Gen8Position { readonly bidId: bigint; readonly amountUnits: bigint; readonly maxPriceQ96: bigint; readonly exited: boolean; readonly outbid: boolean }
type Counted = Pick<Gen8Position, "exited" | "outbid">;
/** Slots held: bids that are neither exited nor outbid. */
export const liveBids = (positions: readonly Counted[]): number => positions.filter(bid => !bid.exited && !bid.outbid).length;
/** Bids the wallet may still place: free live slots within its lifetime cap (exited and outbid bids keep counting toward it). */
export const bidsRemaining = (positions: readonly Counted[]): number =>
  Math.max(0, Math.min(GEN8_MAX_LIVE_BIDS - liveBids(positions), GEN8_MAX_WALLET_BIDS - positions.length));

export interface Gen8WalletLimits {
  readonly creatorExcluded: boolean; readonly termsAccepted: boolean; readonly positions: readonly Gen8Position[];
  readonly allowance: bigint; readonly balance: bigint; readonly minimumBid: bigint;
}
export type Gen8Refusal = "creator" | "terms" | "bids" | "minimum" | "cap";
/** The largest new bid: the hook's allowance, bounded by what the balance covers with the on-top fee. */
export function maximumNewBid(limits: Pick<Gen8WalletLimits, "allowance" | "balance">): bigint {
  const affordable = affordableBid(limits.balance);
  return affordable < limits.allowance ? affordable : limits.allowance;
}
/** What the hook would refuse for `amount`; undefined means it may proceed (the simulation stays authoritative). A rebid frees its own slot. */
export function bidRefusal(limits: Gen8WalletLimits, amount: bigint, rebid = false): Gen8Refusal | undefined {
  if (limits.creatorExcluded) return "creator";
  if (!limits.termsAccepted) return "terms";
  if (!rebid && bidsRemaining(limits.positions) === 0) return "bids";
  if (amount < limits.minimumBid) return "minimum";
  // A rebid exits its outbid bid first, which the hook accounts for on chain; only a new bid can be capped here.
  if (!rebid && amount > maximumNewBid(limits)) return "cap";
  return undefined;
}

/**
 * Aligns a requested price down to the auction's tick and checks it lies above the floor and clearing price and within the CCA
 * maximum. Prices are Q96 quote units per token unit (the CCA's native price).
 */
export function alignBidPrice(requestedQ96: bigint, auction: { floorPriceQ96: bigint; tickSpacingQ96: bigint; maxPriceQ96: bigint; clearingPriceQ96: bigint }): bigint {
  check(requestedQ96 > 0n && auction.tickSpacingQ96 > 0n && auction.floorPriceQ96 > 0n, "INVALID_BID_PRICE", "Price inputs must be positive");
  const price = requestedQ96 / auction.tickSpacingQ96 * auction.tickSpacingQ96;
  check(price >= auction.floorPriceQ96 && price > auction.clearingPriceQ96 && price <= auction.maxPriceQ96,
    "INVALID_BID_PRICE", "Bid price must be on tick, at least the floor, above the clearing price and within the CCA ceiling");
  return price;
}
