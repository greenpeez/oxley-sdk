import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Abi } from "viem";
import { termsRegistryAbi, openingFeeCurveAbi, gen8CurveAbi, gen8BidRouterAbi, gen8BidHookAbi, ccaCheckpointAbi, gen8AdapterAbi, curveAbi, tokenAbi,
  registryAbi, oxleyRevertAbi } from "../src/abis.js";
import { full, read } from "./support/chain.js";
import { matches } from "./support/abi.js";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const pkg = JSON.parse(read("package.json")), evidence = JSON.parse(read("docs/live-artifacts.json"));

test("Gen3 and Gen8 ABIs are the hash-pinned compiler ABIs and are exported under the documented paths", () => {
  assert.equal(evidence.evidence.length, 5); assert.equal(evidence.chainId, 99801);
  for (const item of evidence.evidence) {
    assert.equal(sha(readFileSync(new URL(`../abis/${item.name}.json`, import.meta.url))), item.abiSha256, item.name);
    assert.match(item.sourceSha256, /^[0-9a-f]{64}$/); assert.match(item.soliditySha256, /^[0-9a-f]{64}$/);
    assert.equal(pkg.exports[item.export.replace("@oxley/sdk", ".")], `./abis/${item.name}.json`, item.export);
  }
  for (const item of evidence.deployments) {
    assert.ok(existsSync(new URL(`../${item.file}`, import.meta.url)), item.file);
    assert.equal(pkg.exports[`./${item.file}`], `./${item.file}`, item.file);
  }
});
test("every typed subset entry matches the compiled ABI it claims to mirror", () => {
  const [gen3, terms, gen8, router, hook, cca, flat, adapter] = ["ElysiumReserveCurveGen3", "OxleyTermsRegistry", "ElysiumCurveGen8", "ElysiumCcaBidRouterGen8",
    "ElysiumDynamicBidHookGen8", "ContinuousClearingAuction", "ElysiumReserveCurveVNext", "ElysiumUniswapCcaAdapter"].map(full) as Abi[];
  const subsets: [string, readonly { type: string; name?: string }[], Abi][] = [
    ["terms registry", termsRegistryAbi, terms!], ["opening fee on Gen3", openingFeeCurveAbi, gen3!], ["opening fee on Gen8", openingFeeCurveAbi, gen8!],
    ["Gen8 curve", gen8CurveAbi, gen8!], ["Gen8 router", gen8BidRouterAbi, router!], ["Gen8 hook", gen8BidHookAbi, hook!],
    ["CCA checkpoints", ccaCheckpointAbi, cca!], ["adapter ceiling", gen8AdapterAbi, adapter!],
    // The flat-fee entries the SDK keeps reading are unchanged in the Gen3 curve.
    ["flat-fee reads on Gen3", curveAbi, gen3!],
  ];
  for (const [label, subset, abi] of subsets) for (const entry of subset) assert.ok(matches(entry, abi), `${label}: ${entry.type} ${entry.name}`);
  assert.ok(curveAbi.every(entry => matches(entry, flat!)));
  assert.ok(tokenAbi.every(entry => entry.type === "function") && registryAbi.length === 1);
  const sources = [terms!, gen3!, gen8!, router!, hook!, cca!, full("ElysiumReserveCurveGen2"), full("ElysiumBreadthCcaBidHook"), full("ElysiumBondedCcaLaunchControllerGen2")];
  for (const entry of oxleyRevertAbi) assert.ok(sources.some(abi => matches(entry, abi)), entry.name);
});
test("the Gen8 manifest is the production record mapped role by role, and Gen3 keeps its reviewed pins", () => {
  const gen8 = JSON.parse(read("deployments/elysium-testnet-gen8.json")), gen3 = JSON.parse(read("deployments/elysium-testnet-gen3.json"));
  assert.equal(gen8.releaseId, "elysium-auctions-gen8-969bd0e317da4145"); assert.equal(gen8.startBlock, "18154191");
  assert.equal(gen8.auctionController, "0xf7ca8d5bf0c9fc3d4e97e43d3fb404a9867fc00e");
  assert.deepEqual(gen8.bidRules, { version: "8", minBid: "20000000", tokenCap: "30000000000000000000000000", liveBids: 3, walletBids: 12,
    hookMaxBids: 0, capacityMaxBids: 0, maxPriceLevels: 1000 });
  assert.equal(gen3.releaseId, "elysium-auctions-gen3-aac49c62c3855f41"); assert.deepEqual(gen3.termsRegistry, gen3.gen3.termsRegistry);
  // Gen2 is deliberately not bundled: its 14 auctions all failed, so no market exists on its curve.
  assert.equal(JSON.parse(read("deployments/elysium-testnet-gen2.json")).status, "planned-fork-addresses");
});
test("every exported path exists and the changelog and README describe the released version", () => {
  for (const [path, target] of Object.entries(pkg.exports as Record<string, unknown>)) {
    for (const file of typeof target === "string" ? [target] : [] as string[]) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${path} -> ${file}`);
  }
  assert.equal(pkg.version, "0.6.0-next.1");
  assert.match(read("CHANGELOG.md"), new RegExp(`^# Changelog\\n\\n## ${pkg.version.replace(/\./g, "\\.")} - `));
  assert.match(read("README.md"), new RegExp(`version \`${pkg.version.replace(/\./g, "\\.")}\``));
});
