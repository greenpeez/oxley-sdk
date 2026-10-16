import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, type Hex } from "viem";
import { createOxleyAuctionClient, auctionBidRouterAbi } from "../src/auctions.js";

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
const auction = await client.getAuction((process.env.OXLEY_AUCTION_ID
  ?? "0x71d75a89abd94f6e48e76b94da911ee67ac8a976525dd73908c0cd37661b2093") as Hex);
const [principal, debit, fee] = await publicClient.readContract({ address: deployment.auctionBindings.bidRouter.address,
  abi: auctionBidRouterAbi, functionName: "quoteBid", args: [100_000_000n], blockNumber: auction.blockNumber });
assert.equal(principal, 100_000_000n); assert.equal(debit, 100_100_000n); assert.equal(fee, 100_000n);
console.log(JSON.stringify({ version: "0.5.0-next.2", chainId: deployment.chainId, runtimePinsMatch: true,
  quoted: { principal, debit, fee }, auction }, (_, value) => typeof value === "bigint" ? value.toString() : value));
