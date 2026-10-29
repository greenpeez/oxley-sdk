import { maxUint256, type Address, type Hex } from "viem";
import { breadthBidHookAbi } from "./gen2-abis.js";
import { walletCapMessage } from "./revert.js";
import { address, check, hash, OxleyError, sameAddress } from "./validation.js";
import type { AuctionContext } from "./auction-context.js";
import type { AuctionReader } from "./auction-state.js";

export function createBidAllowanceReader(context: AuctionContext, auctions: AuctionReader) {
  const { rpc, deployment, bidRouter, gen2, anchor, canonical } = context;
  const { resolveAt } = auctions;
  /** Gen2 breadth-rule state for one owner, read from the hook bound to the verified router and adapter. */
  async function breadthAt(auction: Address, owner: Address, hook: Address, blockNumber: bigint) {
    const base = { address: hook, abi: breadthBidHookAbi, blockNumber } as const;
    const [router, registered, walletAllowance, walletCap, minimumGrossRaise, counted, breadthReached, committed, creatorExcluded] = await Promise.all([
      rpc.readContract({ ...base, functionName: "bidRouter" }),
      rpc.readContract({ ...base, functionName: "isRegistered", args: [auction] }),
      rpc.readContract({ ...base, functionName: "walletAllowance", args: [auction, owner] }),
      rpc.readContract({ ...base, functionName: "walletCap", args: [auction] }),
      rpc.readContract({ ...base, functionName: "minimumGrossRaise", args: [auction] }),
      rpc.readContract({ ...base, functionName: "counted", args: [auction] }),
      rpc.readContract({ ...base, functionName: "breadthReached", args: [auction] }),
      rpc.readContract({ ...base, functionName: "committed", args: [auction, owner] }),
      rpc.readContract({ ...base, functionName: "isExcludedBidder", args: [auction, owner] }),
    ]);
    check(sameAddress(router, bidRouter.address), "AUCTION_BINDING_MISMATCH", "Bid hook is bound to another router");
    // Mirrors the hook's own rules; any disagreement means an unexpected hook, so fail closed.
    const expected = !registered || creatorExcluded ? 0n : breadthReached ? maxUint256 : committed >= walletCap ? 0n : walletCap - committed;
    check(walletAllowance === expected && breadthReached === (registered && counted >= minimumGrossRaise)
      && (!registered || (walletCap > 0n && minimumGrossRaise > 0n)), "INVALID_BID_HOOK_STATE", "Bid hook views are inconsistent");
    return Object.freeze({ hook, registered, walletAllowance, unlimited: walletAllowance === maxUint256, walletCap,
      minimumGrossRaise, counted, breadthReached, committed, creatorExcluded });
  }
  function requireBidAllowed(breadth: Awaited<ReturnType<typeof breadthAt>>, owner: Address, principal: bigint) {
    check(breadth.registered, "AUCTION_NOT_REGISTERED", "This auction is not registered with the bid rules and cannot accept bids");
    if (breadth.creatorExcluded) throw new OxleyError("CREATOR_BID_NOT_ALLOWED", "Creators can't bid on their own auction", { owner });
    if (!breadth.unlimited && principal > breadth.walletAllowance) throw new OxleyError("WALLET_CAP_EXCEEDED",
      walletCapMessage(breadth.walletAllowance, deployment.quoteToken.symbol), { owner, principal, walletAllowance: breadth.walletAllowance });
  }
  async function getBidAllowance(input: { dealId: Hex; owner: Address }) {
    check(gen2, "GEN2_REQUIRED", "Bid allowances exist only on Gen2 deployments");
    hash(input.dealId); address(input.owner);
    const at = await anchor(), { hook, auction } = await resolveAt(input.dealId, at);
    const breadth = await breadthAt(auction.auction, input.owner, hook, at.blockNumber);
    await canonical(at);
    return { ...at, ...auction, owner: input.owner, ...breadth };
  }
  return { breadthAt, requireBidAllowed, getBidAllowance };
}
export type BidAllowanceReader = ReturnType<typeof createBidAllowanceReader>;
