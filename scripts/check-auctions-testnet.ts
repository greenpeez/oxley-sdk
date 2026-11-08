import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, type Hex } from "viem";
import { createOxleyAuctionClient, auctionBidRouterAbi } from "../src/auctions.js";

// Read-only: no signer, no transaction, no state change.
const deployment = JSON.parse(readFileSync(new URL("../deployments/elysium-testnet.json", import.meta.url), "utf8"));
let nextRequest = 0;
const pacedFetch: typeof fetch = async (input, init) => {
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Date.now() + wait + 550;
  await delay(wait);
  return fetch(input, init);
};
const publicClient = createPublicClient({ transport: http(process.env.OXLEY_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz",
  { timeout: 30_000, retryCount: 1, fetchFn: pacedFetch }) });
const client = createOxleyAuctionClient({ publicClient, deployment });
// Pins, bindings, the Dynamic Bids hook, exposure helper, terms registry, compiled bid rules, floor cap and minimum raise, all at one block.
const verified = await client.verifyDeployment();
const [principal, debit, fee] = await publicClient.readContract({ address: deployment.auctionBindings.bidRouter.address,
  abi: auctionBidRouterAbi, functionName: "quoteBid", args: [100_000_000n], blockNumber: verified.blockNumber });
assert.equal(principal, 100_000_000n); assert.equal(debit, 100_100_000n); assert.equal(fee, 100_000n);
// An activated or open auction is optional: set OXLEY_AUCTION_ID to read it back and OXLEY_BIDDER to read that wallet's limits.
const auction = process.env.OXLEY_AUCTION_ID ? await client.getAuction(process.env.OXLEY_AUCTION_ID as Hex) : null;
const limits = auction && process.env.OXLEY_BIDDER
  ? await client.getDynamicBidLimits({ dealId: auction.dealId, owner: process.env.OXLEY_BIDDER as Hex }) : null;
console.log(JSON.stringify({ version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, chainId: deployment.chainId,
  releaseId: deployment.releaseId, runtimePinsMatch: true, graphVerified: true, quoted: { principal, debit, fee }, auction, limits },
(_, value) => typeof value === "bigint" ? value.toString() : value));
