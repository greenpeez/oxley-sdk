import type { Hex } from "viem";
import { auctionControllerAbi, auctionAdapterAbi, ccaAuctionAbi } from "./auction-abis.js";
import { registryAbi } from "./abis.js";
import { address, check, hash, sameAddress } from "./validation.js";
import type { Anchor } from "./types.js";
import type { AuctionContext } from "./auction-context.js";

export function createAuctionReader(context: AuctionContext) {
  const { rpc, deployment, controller, adapter, anchor, canonical, verifyAt } = context;
  async function auctionAt(dealId: Hex, at: Anchor) { return (await resolveAt(dealId, at)).auction; }
  async function resolveAt(dealId: Hex, at: Anchor) {
    hash(dealId);
    const hook = await verifyAt(at), blockNumber = at.blockNumber;
    const [campaign, deal, auction] = await Promise.all([
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "campaign", args: [dealId], blockNumber }),
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [dealId], blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "auctionFor", args: [dealId], blockNumber }),
    ]);
    address(auction);
    check(deal.profile === 1 && sameAddress(deal.controller, controller) && campaign[2].toLowerCase() === dealId.toLowerCase()
      && sameAddress(deal.coin, campaign[1]) && sameAddress(deal.creator, campaign[0])
      && sameAddress(deal.reserveAsset, deployment.quoteToken.address),
    "UNSUPPORTED_AUCTION", "Auction does not belong to the reviewed deployment");
    const [code, coin, currency, auctionHook] = await Promise.all([
      rpc.getCode({ address: auction, blockNumber }),
      rpc.readContract({ address: auction, abi: ccaAuctionAbi, functionName: "token", blockNumber }),
      rpc.readContract({ address: auction, abi: ccaAuctionAbi, functionName: "currency", blockNumber }),
      rpc.readContract({ address: auction, abi: ccaAuctionAbi, functionName: "validationHook", blockNumber }),
    ]);
    check(code && code !== "0x" && sameAddress(coin, deal.coin) && sameAddress(currency, deployment.quoteToken.address)
      && sameAddress(auctionHook, hook), "AUCTION_BINDING_MISMATCH", "Unexpected auction token, currency or hook");
    return { hook, auction: { dealId, auction, coin, open: campaign[4], status: deal.status } };
  }
  async function getAuction(dealId: Hex) {
    const at = await anchor(), auction = await auctionAt(dealId, at); await canonical(at);
    return { ...auction, ...at };
  }
  return { resolveAt, auctionAt, getAuction };
}
export type AuctionReader = ReturnType<typeof createAuctionReader>;
