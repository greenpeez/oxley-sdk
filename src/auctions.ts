import { keccak256, type Address, type Hex } from "viem";
import { auctionControllerAbi, auctionBidRouterAbi, auctionAdapterAbi, ccaAuctionAbi } from "./auction-abis.js";
import { registryAbi, tokenAbi } from "./abis.js";
import { bidInputs, buildAuctionBid, buildAuctionBidApprovals, buildAuctionClaim, buildAuctionRefund,
  type AuctionBidInput, type PartialFillHints } from "./auction-transactions.js";
import { address, check, hash, parseDeployment, sameAddress, uint } from "./validation.js";
import type { Anchor, ContractPin, Deployment, RpcClient, Transaction } from "./types.js";
export { buildAuctionBid, buildAuctionBidApprovals, buildAuctionClaim, buildAuctionRefund } from "./auction-transactions.js";
export type { AuctionBidInput, PartialFillHints } from "./auction-transactions.js";
export * from "./auction-abis.js";

export interface AuctionDeployment extends Deployment {
  auctionBindings: { controllerRuntimeCodeHash: Hex; bidRouter: ContractPin; adapter: ContractPin };
}
export function parseAuctionDeployment(input: unknown): AuctionDeployment {
  const deployment = parseDeployment(input);
  const pins = (input as AuctionDeployment).auctionBindings;
  check(pins && typeof pins === "object", "AUCTION_BINDINGS_REQUIRED", "Reviewed auction runtime pins are required");
  hash(pins.controllerRuntimeCodeHash);
  for (const pin of [pins.bidRouter, pins.adapter]) {
    check(pin && typeof pin === "object", "AUCTION_BINDINGS_REQUIRED", "Router and adapter pins required");
    address(pin.address); hash(pin.runtimeCodeHash);
  }
  check(new Set([deployment.auctionController, pins.bidRouter.address, pins.adapter.address,
    deployment.quoteToken.address, deployment.registry.address].map(a => a.toLowerCase())).size === 5,
  "INVALID_DEPLOYMENT", "Auction contracts and quote token must be distinct");
  return Object.freeze({ ...deployment, auctionBindings: Object.freeze({ ...pins,
    bidRouter: Object.freeze({ ...pins.bidRouter }), adapter: Object.freeze({ ...pins.adapter }) }) });
}
export function createOxleyAuctionClient(options: { publicClient: RpcClient; deployment: unknown }) {
  const rpc = options.publicClient, deployment = parseAuctionDeployment(options.deployment);
  const { bidRouter, adapter } = deployment.auctionBindings;
  const controller = deployment.auctionController;
  async function anchor(): Promise<Anchor> {
    const [chain, block] = await Promise.all([rpc.getChainId(), rpc.getBlock({ blockTag: "latest" })]);
    check(chain === deployment.chainId, "CHAIN_MISMATCH", "RPC chain does not match deployment");
    check(block.number !== null && block.hash !== null && block.number >= BigInt(deployment.startBlock),
      "INVALID_BLOCK", "A mined block after deployment is required");
    return { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp };
  }
  async function canonical(at: Anchor) {
    check((await rpc.getBlock({ blockNumber: at.blockNumber })).hash === at.blockHash,
      "REORG", "Auction observation changed; discard and prepare again");
  }
  async function verifyAt(at: Anchor) {
    await Promise.all([bidRouter, adapter, deployment.registry, deployment.quoteToken,
      { address: controller, runtimeCodeHash: deployment.auctionBindings.controllerRuntimeCodeHash }].map(async pin => {
      const code = await rpc.getCode({ address: pin.address, blockNumber: at.blockNumber });
      check(code && code !== "0x" && sameAddress(keccak256(code), pin.runtimeCodeHash),
        "CODE_MISMATCH", `Auction runtime differs at ${pin.address}`);
    }));
    const blockNumber = at.blockNumber;
    const [router, cca, quote, registry, routerAdapter, routerQuote, adapterController, adapterQuote, hook, adapterHook, decimals] = await Promise.all([
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "feeBidRouter", blockNumber }),
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "ccaAdapter", blockNumber }),
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "quoteAsset", blockNumber }),
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "registry", blockNumber }),
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "adapter", blockNumber }),
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "quoteAsset", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "controller", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "quoteAsset", blockNumber }),
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "validationHook", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "validationHook", blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "decimals", blockNumber }),
    ]);
    check(sameAddress(router, bidRouter.address) && sameAddress(cca, adapter.address)
      && sameAddress(quote, deployment.quoteToken.address) && sameAddress(registry, deployment.registry.address)
      && sameAddress(routerAdapter, adapter.address) && sameAddress(routerQuote, quote)
      && sameAddress(adapterController, controller) && sameAddress(adapterQuote, quote)
      && sameAddress(hook, adapterHook) && decimals === 6,
    "AUCTION_BINDING_MISMATCH", "Controller, router, adapter or quote binding mismatch");
    address(hook);
    return hook;
  }
  async function auctionAt(dealId: Hex, at: Anchor) {
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
    return { dealId, auction, coin, open: campaign[4], status: deal.status };
  }
  async function verifyDeployment() {
    const at = await anchor(); await verifyAt(at); await canonical(at);
    return { deployment, ...at };
  }
  async function getAuction(dealId: Hex) {
    const at = await anchor(), auction = await auctionAt(dealId, at); await canonical(at);
    return { ...auction, ...at };
  }
  async function prepareBid(input: AuctionBidInput & { caller: Address; simulate?: boolean }) {
    bidInputs(input); address(input.caller);
    const at = await anchor(), auction = await auctionAt(input.dealId, at), blockNumber = at.blockNumber;
    check(input.deadline > at.timestamp, "EXPIRED_DEADLINE", "Supply a future Unix deadline");
    const [quoted, start, end, current, floor, spacing, maximum, balance, allowance] = await Promise.all([
      rpc.readContract({ address: bidRouter.address, abi: auctionBidRouterAbi, functionName: "quoteBid", args: [input.entered], blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "startBlock", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "endBlock", blockNumber }),
      rpc.readContract({ address: adapter.address, abi: auctionAdapterAbi, functionName: "currentBlock", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "floorPrice", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "tickSpacing", blockNumber }),
      rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "MAX_BID_PRICE", blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "balanceOf", args: [input.caller], blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "allowance", args: [input.caller, bidRouter.address], blockNumber }),
    ]);
    check(auction.open && current >= start && current < end, "AUCTION_NOT_OPEN", "Auction is not accepting bids");
    check(spacing > 0n && input.maxPriceQ96 > floor && input.maxPriceQ96 <= maximum
      && input.maxPriceQ96 % spacing === 0n, "INVALID_BID_PRICE", "Bid price must be above floor, on tick and within the CCA ceiling");
    const [principal, debit, fee] = quoted;
    check(principal > 0n && debit === principal + fee, "INVALID_BID_QUOTE", "Inconsistent router quote");
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
      sufficientBalance: balance >= debit, owner: input.caller, simulated: input.simulate === true };
  }
  async function recovery(input: { dealId: Hex; bidId: bigint; caller: Address; partialFill?: PartialFillHints }, claim: boolean) {
    uint(input.bidId, false); address(input.caller);
    const at = await anchor(), auction = await auctionAt(input.dealId, at);
    const bid = await rpc.readContract({ address: auction.auction, abi: ccaAuctionAbi, functionName: "bids",
      args: [input.bidId], blockNumber: at.blockNumber });
    address(bid.owner);
    check(claim ? bid.exitedBlock > 0n && bid.tokensFilled > 0n : bid.exitedBlock === 0n,
      claim ? "NOT_CLAIMABLE" : "ALREADY_EXITED", claim ? "Exit first; no unclaimed token allocation is available" : "Bid already exited");
    const args = { chainId: deployment.chainId, auction: auction.auction, bidId: input.bidId };
    const transaction: Transaction = claim ? buildAuctionClaim(args) : buildAuctionRefund({ ...args, partialFill: input.partialFill });
    // Simulation enforces graduation, timing and exact partial-fill hints without writing chain state.
    await rpc.call({ ...transaction, account: input.caller, blockNumber: at.blockNumber });
    await canonical(at);
    return { ...at, ...auction, transaction, bidId: input.bidId, owner: bid.owner, simulated: true as const };
  }
  return { deployment, verifyDeployment, getAuction, prepareBid,
    prepareClaim: (input: { dealId: Hex; bidId: bigint; caller: Address }) => recovery(input, true),
    prepareRefund: (input: { dealId: Hex; bidId: bigint; caller: Address; partialFill?: PartialFillHints }) => recovery(input, false),
  };
}
