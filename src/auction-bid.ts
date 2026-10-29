import type { Address } from "viem";
import { auctionBidRouterAbi, auctionAdapterAbi, ccaAuctionAbi } from "./auction-abis.js";
import { tokenAbi } from "./abis.js";
import { bidInputs, buildAuctionBid, buildAuctionBidApprovals, type AuctionBidInput } from "./auction-transactions.js";
import { address, check } from "./validation.js";
import type { AuctionContext } from "./auction-context.js";
import type { AuctionReader } from "./auction-state.js";
import type { BidAllowanceReader } from "./auction-breadth.js";

function checkBidPrice(price: bigint, floor: bigint, spacing: bigint, maximum: bigint) {
  check(spacing > 0n && price > floor && price <= maximum && price % spacing === 0n,
    "INVALID_BID_PRICE", "Bid price must be above floor, on tick and within the CCA ceiling");
}
export function createBidPreparer(context: AuctionContext, auctions: AuctionReader, allowances: BidAllowanceReader) {
  const { rpc, deployment, bidRouter, adapter, gen2, anchor, canonical } = context;
  const { resolveAt } = auctions;
  const { breadthAt, requireBidAllowed } = allowances;
  async function prepareBid(input: AuctionBidInput & { caller: Address; simulate?: boolean }) {
    check(!context.gen8, "DYNAMIC_BID_REQUIRED", "Gen8 bids carry per-wallet witnesses: use prepareDynamicBid");
    bidInputs(input); address(input.caller);
    const at = await anchor(), { hook, auction } = await resolveAt(input.dealId, at), blockNumber = at.blockNumber;
    check(input.deadline > at.timestamp, "EXPIRED_DEADLINE", "Supply a future Unix deadline");
    const [reads, breadth] = await Promise.all([Promise.all([
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "quoteBid", args: [input.entered], blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "startBlock", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "endBlock", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "currentBlock", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "floorPrice", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "tickSpacing", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "MAX_BID_PRICE", blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "balanceOf", args: [input.caller], blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "allowance", args: [input.caller, bidRouter.address], blockNumber }),
    ]), gen2 ? breadthAt(auction.auction, input.caller, hook, blockNumber) : null]);
    const [quoted, start, end, current, floor, spacing, maximum, balance, allowance] = reads;
    check(auction.open && current >= start && current < end, "AUCTION_NOT_OPEN", "Auction is not accepting bids");
    checkBidPrice(input.maxPriceQ96, floor, spacing, maximum);
    const [principal, debit, fee] = quoted;
    check(principal > 0n && debit === principal + fee, "INVALID_BID_QUOTE", "Inconsistent router quote");
    // Gen2: the hook's cap applies to principal; fail closed here rather than in simulation or the wallet.
    if (breadth) requireBidAllowed(breadth, input.caller, principal);
    const transaction = buildAuctionBid({ ...input, chainId: deployment.chainId, bidRouter: bidRouter.address });
    const approvals = buildAuctionBidApprovals({ chainId: deployment.chainId, quoteToken: deployment.quoteToken.address,
      bidRouter: bidRouter.address, debit, currentAllowance: allowance });
    if (input.simulate) {
      check(balance >= debit, "INSUFFICIENT_BALANCE", "Caller needs principal plus the quoted fee");
      check(approvals.length === 0, "APPROVAL_REQUIRED", "Confirm approvals before simulating the bid");
      await rpc.call({ ...transaction, account: input.caller, blockNumber });
    }
    await canonical(at);
    return { ...at, ...auction, transaction, principal, debit, fee, approvals, balance, allowance,
      sufficientBalance: balance >= debit, owner: input.caller, simulated: input.simulate === true,
      ...(breadth ? { bidAllowance: breadth } : {} as { bidAllowance?: never }) };
  }
  return prepareBid;
}
