import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Abi } from "viem";
import { termsRegistryAbi, openingFeeCurveAbi, curveAbi, tradingGateAbi, auctionBidRouterAbi, bidHookAbi, ccaCheckpointAbi, ccaAuctionAbi, auctionAdapterAbi,
  tokenAbi, registryAbi, oxleyRevertAbi, launchMinimumRaiseAbi } from "../src/abis.js";
import { launchMinimumRaiseAbi as fromIndex } from "../src/index.js";
import { launchMinimumRaiseAbi as fromAuctions } from "../src/auctions.js";
import { launchMinimumRaiseAbi as fromLaunch } from "../src/launch.js";
import { full, read } from "./support/chain.js";
import { matches } from "./support/abi.js";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const pkg = JSON.parse(read("package.json")), live = JSON.parse(read("docs/live-artifacts.json")), auctionEvidence = JSON.parse(read("docs/auction-artifacts.json"));
const fixtureAbi = (name: string) => (JSON.parse(read(`test/fixtures/${name}.json`)) as { abi: Abi }).abi;

test("the published ABIs are the hash-pinned compiler ABIs and are exported under the documented paths", () => {
  assert.equal(live.evidence.length, 4); assert.equal(live.chainId, 99801);
  for (const item of live.evidence) {
    assert.equal(sha(readFileSync(new URL(`../${item.file}`, import.meta.url))), item.abiSha256, item.contract);
    assert.match(item.sourceSha256, /^[0-9a-f]{64}$/); assert.match(item.soliditySha256, /^[0-9a-f]{64}$/);
    assert.equal(pkg.exports[item.export.replace("@oxley/sdk", ".")], `./${item.file}`, item.export);
  }
  for (const item of live.deployments) {
    assert.ok(existsSync(new URL(`../${item.file}`, import.meta.url)), item.file);
    assert.equal(pkg.exports[`./${item.file}`], `./${item.file}`, item.file);
  }
  // The continuous clearing auction is the vendor's: its ABI, fixture and hashes are pinned in docs/auction-artifacts.json.
  const cca = auctionEvidence.evidence.find((item: { name: string }) => item.name === "ContinuousClearingAuction");
  const raw = readFileSync(new URL("../abis/cca-auction.json", import.meta.url)), fixture = readFileSync(new URL("fixtures/ContinuousClearingAuction.json", import.meta.url));
  assert.equal(sha(raw), cca.abiSha256); assert.equal(sha(fixture), cca.fixtureSha256);
  assert.deepEqual(JSON.parse(raw.toString()), JSON.parse(fixture.toString()).abi);
  assert.equal(pkg.exports["./abis/cca-auction.json"], "./abis/cca-auction.json");
  // Nothing else is exported from abis/: the router, hook, curve, terms registry and CCA are the only published full ABIs.
  assert.deepEqual(Object.keys(pkg.exports).filter(path => path.startsWith("./abis/")).sort(),
    ["./abis/bid-hook.json", "./abis/bid-router.json", "./abis/cca-auction.json", "./abis/curve.json", "./abis/terms-registry.json"]);
  for (const item of auctionEvidence.evidence) {
    assert.equal(sha(readFileSync(new URL(`fixtures/${item.name}.json`, import.meta.url))), item.fixtureSha256, item.name);
  }
});
test("every typed subset entry matches the compiled ABI it claims to mirror", () => {
  const [terms, curve, router, hook, cca] = ["terms-registry", "curve", "bid-router", "bid-hook", "cca-auction"].map(full) as Abi[];
  const adapter = fixtureAbi("ElysiumUniswapCcaAdapter");
  const subsets: [string, readonly { type: string; name?: string }[], Abi][] = [
    ["terms registry", termsRegistryAbi, terms!], ["curve", curveAbi, curve!], ["opening fee", openingFeeCurveAbi, curve!], ["trading gate", tradingGateAbi, curve!],
    ["router", auctionBidRouterAbi, router!], ["hook", bidHookAbi, hook!], ["CCA checkpoints", ccaCheckpointAbi, cca!], ["CCA", ccaAuctionAbi, cca!],
    ["adapter", auctionAdapterAbi, adapter],
  ];
  for (const [label, subset, abi] of subsets) for (const entry of subset) assert.ok(matches(entry, abi), `${label}: ${entry.type} ${entry.name}`);
  assert.ok(tokenAbi.every(entry => entry.type === "function") && registryAbi.length === 1);
  const sources = [terms!, curve!, router!, hook!, cca!];
  for (const entry of oxleyRevertAbi) assert.ok(sources.some(abi => matches(entry, abi)), entry.name);
});
test("the minimum raise views are exported from every entry point and are exactly the two controller getters", () => {
  assert.deepEqual(launchMinimumRaiseAbi.map(item => [item.type, item.name, item.stateMutability]), [["function", "minimumRaise", "view"], ["function", "minimumGrossRaise", "view"]]);
  assert.equal(fromIndex, launchMinimumRaiseAbi); assert.equal(fromAuctions, launchMinimumRaiseAbi); assert.equal(fromLaunch, launchMinimumRaiseAbi);
});
test("every exported path exists and the changelog and README describe the released version", () => {
  for (const [path, target] of Object.entries(pkg.exports as Record<string, unknown>)) {
    for (const file of typeof target === "string" ? [target] : [] as string[]) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${path} -> ${file}`);
  }
  assert.equal(pkg.version, "0.7.0-next.0");
  // An "Unreleased" section may sit above the released version's section.
  assert.match(read("CHANGELOG.md"), new RegExp(`^# Changelog\\n\\n(?:## Unreleased\\n[\\s\\S]*?\\n\\n)?## ${pkg.version.replace(/\./g, "\\.")} - `));
  assert.match(read("README.md"), new RegExp(`version \`${pkg.version.replace(/\./g, "\\.")}\``));
});
