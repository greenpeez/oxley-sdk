import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { createOxleyAuctionClient } from "../src/auctions.js";
import { createOxleyLaunchClient, launchDealId, launchFloorAbi, minimumRaiseFloor, newDraftSalt, quoteAuctionFloor, validateLaunchFloor } from "../src/launch.js";
import { OxleyError } from "../src/index.js";

// Read-only: the launch floor rules checked against the live adapter and controller, and the launch client against the live launch graph; no signer, no transaction.
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
// Verification reads the controller's floor cap and its 30,000 USDC net minimum raise.
const verified = await createOxleyAuctionClient({ publicClient, deployment }).verifyDeployment();
const lowest = minimumRaiseFloor();
for (const price of [9_959_120_000_000_000_000n, 10n ** 19n, 10n ** 20n, lowest, lowest - 1n, 10n ** 21n]) {
  const expected = quoteAuctionFloor(price);
  const actual = await publicClient.readContract({ address: deployment.auctionBindings.adapter.address, abi: launchFloorAbi,
    functionName: "effectiveFloor", args: [price], blockNumber: verified.blockNumber });
  assert.deepEqual(actual, [expected.floorPriceQ96, expected.tickSpacingQ96]);
}
assert.doesNotThrow(() => validateLaunchFloor(lowest));
assert.throws(() => validateLaunchFloor(lowest - 1n));
// The launch client: the whole launch graph verified at one block, then a launch prepared for a wallet that holds nothing. Every chain read the preparation makes (deal id,
// creator account, ticker, deal, effective floor, terms) must succeed before it reaches the balance check and refuses with INSUFFICIENT_QUOTE.
const launches = createOxleyLaunchClient({ publicClient, deployment });
const launchGraph = await launches.verifyDeployment();
assert.deepEqual([launchGraph.launchFee, launchGraph.deployerBondWei], [1_500_000n, 500_000_000_000_000_000n]);
const controller = deployment.auctionController as Address;
const namespace = await publicClient.readContract({ address: controller, abi: parseAbi(["function LAUNCH_NAMESPACE() view returns (bytes32)"]), functionName: "LAUNCH_NAMESPACE", blockNumber: launchGraph.blockNumber });
assert.equal(namespace, "0x265ed5d0ea8ae47c1971c5643a4c5aabbe305fb04094380952a15d2c460b2ed8");
const probe = { owner: "0x00000000000000000000000000000000000c0de1", draftSalt: newDraftSalt(), name: "Probe Coin", symbol: "ZZPROBE1", floorPriceWad: lowest,
  creatorLockDays: 0, listingCommitmentBps: 0, auctionDurationHours: 1, secondsPerBlock: 0.16 } as const;
const derived = await publicClient.readContract({ address: controller, abi: parseAbi(["function dealIdFor(address,bytes32) view returns (bytes32)"]), functionName: "dealIdFor",
  args: [probe.owner, probe.draftSalt], blockNumber: launchGraph.blockNumber });
assert.equal(derived, launchDealId({ chainId: deployment.chainId, controller, owner: probe.owner, draftSalt: probe.draftSalt }));
await assert.rejects(launches.prepareLaunch(probe), (error: unknown) => error instanceof OxleyError && error.code === "INSUFFICIENT_QUOTE");
// An existing launch can be read back by its creator and salt: OXLEY_LAUNCH_OWNER and OXLEY_LAUNCH_SALT.
const owner = process.env.OXLEY_LAUNCH_OWNER as Address | undefined, draftSalt = process.env.OXLEY_LAUNCH_SALT as `0x${string}` | undefined;
const readBack = owner && draftSalt ? await launches.getLaunch({ owner, draftSalt }) : null;
console.log(JSON.stringify({ version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  chainId: deployment.chainId, readOnly: true, runtimePinsMatch: true, minimumRaiseFloor: lowest, blockNumber: verified.blockNumber,
  blockHash: verified.blockHash, floorSamplesMatch: 6,
  launch: { blockNumber: launchGraph.blockNumber, launchFee: launchGraph.launchFee, deployerBondWei: launchGraph.deployerBondWei, maxLaunchGasPrice: launchGraph.maxLaunchGasPrice,
    publicLaunchEnabled: launchGraph.publicLaunchEnabled, entriesPaused: launchGraph.entriesPaused, namespaceMatches: true, dealIdMatches: true, unfundedWalletRefused: "INSUFFICIENT_QUOTE",
    readBack: readBack && { creatorAccount: readBack.creatorAccount, launched: readBack.launched, coin: readBack.coin, auction: readBack.launch?.auction ?? null } } },
(_, v) => typeof v === "bigint" ? v.toString() : v));
