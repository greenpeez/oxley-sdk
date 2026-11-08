import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { creatorAccountFactoryAbi } from "../src/launch-abis.js";

// Read-only: proves on the live chain that every published compiler ABI belongs to the deployed code. For each contract in docs/live-artifacts.json the chain's runtime
// code with the compiler's immutable slots zeroed must hash to the build's runtime template, and its unmasked hash must be the manifest's pinned runtime hash. The creator
// account has no address of its own (the factory deploys it), so accounts the factory created are read instead. No signer, no transaction.
const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const live = read("docs/live-artifacts.json"), manifest = read("deployments/elysium-testnet.json");
let nextRequest = 0;
const pacedFetch: typeof fetch = async (input, init) => {
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Date.now() + wait + 550;
  await delay(wait);
  return fetch(input, init);
};
const publicClient = createPublicClient({ transport: http(process.env.OXLEY_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz", { timeout: 30_000, retryCount: 1, fetchFn: pacedFetch }) });
assert.equal(await publicClient.getChainId(), manifest.chainId);
const head = await publicClient.getBlock({ blockTag: "latest" });
const masked = (code: Hex, slots: [number, number][]) => {
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const [start, length] of slots) bytes.fill(0, start, start + length);
  return keccak256(`0x${bytes.toString("hex")}` as Hex);
};
const checked: string[] = [];
const factory = manifest.launchBindings.creatorAccountFactory.address as Address;
const created = creatorAccountFactoryAbi.find((item): item is Extract<typeof item, { type: "event" }> => item.type === "event")!;
for (const item of live.evidence) {
  const slots = item.immutableReferences as [number, number][];
  // Deployed contracts are read at their pinned address; the creator account at the first account the factory created.
  const addresses: Address[] = item.deployed ? [item.deployed.address] : [(await publicClient.getLogs({ address: factory, event: created, fromBlock: BigInt(manifest.startBlock), toBlock: head.number }))
    .map(log => log.args.account!)[0]!];
  for (const address of addresses) {
    const code = await publicClient.getCode({ address, blockNumber: head.number });
    assert.ok(code && code !== "0x", `${item.role}: no code at ${address}`);
    assert.equal(code.length / 2 - 1, item.runtimeBytes, `${item.role}: runtime size`);
    assert.equal(masked(code, slots), item.runtimeTemplateKeccak256, `${item.role}: runtime code is not the published build`);
    if (item.deployed) assert.equal(keccak256(code), item.deployed.pinnedRuntimeCodeHash, `${item.role}: pinned runtime hash`);
    checked.push(`${item.role}@${address}`);
  }
}
console.log(JSON.stringify({ version: read("package.json").version, chainId: manifest.chainId, readOnly: true, release: live.release.releaseId,
  compiledGraphSha256: live.release.compiledGraphSha256, blockNumber: head.number, blockHash: head.hash, contractsMatchPublishedBuild: checked.length, checked },
(_, v) => typeof v === "bigint" ? v.toString() : v));
