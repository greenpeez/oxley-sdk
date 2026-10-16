import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http } from "viem";
import { createOxleyLaunchClient, launchFloorAbi, quoteAuctionFloor } from "../src/launch.js";

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
const client = createOxleyLaunchClient({ publicClient, deployment });
const verified = await client.verifyDeployment();
for (const price of [9_959_120_000_000_000_000n, 10n ** 19n, 10n ** 20n]) {
  const expected = quoteAuctionFloor(price);
  const actual = await publicClient.readContract({ address: deployment.auctionBindings.adapter.address, abi: launchFloorAbi,
    functionName: "effectiveFloor", args: [price], blockNumber: verified.blockNumber });
  assert.deepEqual(actual, [expected.floorPriceQ96, expected.tickSpacingQ96]);
}
console.log(JSON.stringify({ version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  chainId: deployment.chainId, readOnly: true, runtimePinsMatch: true, launchFee: verified.launchFee,
  deployerBondWei: verified.deployerBondWei, maxLaunchGasPrice: verified.maxLaunchGasPrice, publicLaunchEnabled: verified.publicLaunchEnabled,
  entriesPaused: verified.entriesPaused, blockNumber: verified.blockNumber, blockHash: verified.blockHash,
  floorSamplesMatch: 3 }, (_, v) => typeof v === "bigint" ? v.toString() : v));
