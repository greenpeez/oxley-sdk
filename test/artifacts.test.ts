import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Abi } from "viem";
import { termsRegistryAbi, openingFeeCurveAbi, curveAbi, tradingGateAbi, auctionBidRouterAbi, bidHookAbi, ccaCheckpointAbi, ccaAuctionAbi, auctionAdapterAbi,
  tokenAbi, registryAbi, oxleyRevertAbi, launchMinimumRaiseAbi, launchFloorAbi, launchFloorCapAbi, auctionControllerAbi, launchControllerAbi, creatorAccountFactoryAbi,
  creatorAccountAbi, launchEntryAbi, launchBondAbi } from "../src/abis.js";
import { launchMinimumRaiseAbi as fromIndex } from "../src/index.js";
import { launchMinimumRaiseAbi as fromAuctions } from "../src/auctions.js";
import { launchMinimumRaiseAbi as fromLaunch } from "../src/launch.js";
import { full, read } from "./support/chain.js";
import { matches } from "./support/abi.js";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const pkg = JSON.parse(read("package.json")), live = JSON.parse(read("docs/live-artifacts.json")), auctionEvidence = JSON.parse(read("docs/auction-artifacts.json"));
const record = JSON.parse(read("test/fixtures/production-record.json")) as { compiledGraphSha256: string; releaseId: string; roles: Record<string, { address: string; runtimeCodeHash: string }> };
const bytes32 = /^0x[0-9a-f]{64}$/;
const published = ["adapter", "auction-controller", "bid-hook", "bid-router", "bond-escrow", "cca-auction", "creator-account-factory", "creator-account", "curve", "entry-controller",
  "exposure-helper", "registry", "terms-registry"].map(name => `./abis/${name}.json`);

test("the published ABIs are the compiler ABIs of the deployed build: hash-pinned, tied to the deployment record and exported under the documented paths", () => {
  assert.equal(live.evidence.length, 12); assert.equal(live.chainId, 99801);
  // The compiler job the record names, and the settings every runtime hash below was produced with.
  assert.deepEqual([live.release.releaseId, live.release.compiledGraphSha256], [record.releaseId, record.compiledGraphSha256]);
  assert.match(live.build.compiledGraph.fileSha256, /^[0-9a-f]{64}$/); assert.match(live.build.sourceRepository.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual([live.build.compiler, live.build.settings.evmVersion, live.build.settings.optimizer, live.build.settings.viaIR, live.build.settings.metadata.bytecodeHash, live.build.settings.metadata.appendCBOR],
    ["0.8.26", "cancun", { enabled: true, runs: 200 }, false, "none", false]);
  const manifest = JSON.parse(read("deployments/elysium-testnet.json")), bindings = manifest.auctionBindings, launch = manifest.launchBindings;
  const pins: Record<string, { address: string; runtimeCodeHash: string }> = { curve: manifest.curve, registry: manifest.registry, termsRegistry: manifest.termsRegistry,
    controller: { address: manifest.auctionController, runtimeCodeHash: bindings.controllerRuntimeCodeHash }, bidRouter: bindings.bidRouter, adapter: bindings.adapter, bidHook: bindings.bidHook,
    exposureHelper: bindings.exposureHelper, creatorAccountFactory: launch.creatorAccountFactory, entryController: launch.entryController, bondEscrow: launch.bondEscrow };
  for (const item of live.evidence) {
    assert.equal(sha(readFileSync(new URL(`../${item.file}`, import.meta.url))), item.abiSha256, item.contract);
    assert.match(item.sourceSha256, /^[0-9a-f]{64}$/); assert.match(item.soliditySha256, /^[0-9a-f]{64}$/);
    assert.equal(pkg.exports[item.export.replace("@oxley/sdk", ".")], `./${item.file}`, item.export);
    assert.match(item.creationCodeKeccak256, bytes32); assert.match(item.runtimeTemplateKeccak256, bytes32);
    // Immutable slots are 32-byte words inside the runtime code and never overlap.
    let end = 0;
    for (const [start, length] of item.immutableReferences as [number, number][]) { assert.equal(length, 32); assert.ok(start >= end && start + length <= item.runtimeBytes, item.contract); end = start + length; }
    if (item.deployed === null) { assert.equal(item.role, "creatorAccount"); continue; }
    // Each deployed contract is the one the manifest pins, which is the one the record names; a contract with no immutables is its own template.
    const pin = pins[item.role]!;
    assert.deepEqual([item.deployed.address, item.deployed.pinnedRuntimeCodeHash], [pin.address, pin.runtimeCodeHash], item.role);
    assert.deepEqual([record.roles[item.role]!.address.toLowerCase(), record.roles[item.role]!.runtimeCodeHash], [pin.address, pin.runtimeCodeHash], item.role);
    if (item.immutableReferences.length === 0) assert.equal(item.runtimeTemplateKeccak256, pin.runtimeCodeHash, item.role);
  }
  assert.deepEqual(live.evidence.map((item: { role: string }) => item.role).filter((role: string) => role !== "creatorAccount").sort(), Object.keys(pins).sort());
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
  // Every contract the manifest pins ships its full ABI, but the quote token (Oxy-USDC is not an Oxley build); nothing else is exported from abis/.
  assert.deepEqual(Object.keys(pkg.exports).filter(path => path.startsWith("./abis/")).sort(), published);
  for (const item of auctionEvidence.evidence) {
    assert.equal(sha(readFileSync(new URL(`fixtures/${item.name}.json`, import.meta.url))), item.fixtureSha256, item.name);
  }
});
test("every typed subset entry matches the compiled ABI it claims to mirror", () => {
  const [terms, curve, router, hook, cca, controller, adapter, registry, factory, account, entry, bond, exposure] = ["terms-registry", "curve", "bid-router", "bid-hook", "cca-auction",
    "auction-controller", "adapter", "registry", "creator-account-factory", "creator-account", "entry-controller", "bond-escrow", "exposure-helper"].map(full) as Abi[];
  const subsets: [string, readonly { type: string; name?: string }[], Abi][] = [
    ["terms registry", termsRegistryAbi, terms!], ["curve", curveAbi, curve!], ["opening fee", openingFeeCurveAbi, curve!], ["trading gate", tradingGateAbi, curve!],
    ["router", auctionBidRouterAbi, router!], ["hook", bidHookAbi, hook!], ["CCA checkpoints", ccaCheckpointAbi, cca!], ["CCA", ccaAuctionAbi, cca!],
    ["adapter", auctionAdapterAbi, adapter!], ["adapter floor", launchFloorAbi, adapter!], ["controller", auctionControllerAbi, controller!],
    ["controller floor cap", launchFloorCapAbi, controller!], ["controller minimum raise", launchMinimumRaiseAbi, controller!], ["controller launch", launchControllerAbi, controller!],
    ["registry", registryAbi, registry!], ["factory", creatorAccountFactoryAbi, factory!], ["creator account", creatorAccountAbi, account!],
    ["entry controller", launchEntryAbi, entry!], ["bond escrow", launchBondAbi, bond!],
  ];
  for (const [label, subset, abi] of subsets) for (const entry of subset) assert.ok(matches(entry, abi), `${label}: ${entry.type} ${entry.name}`);
  // The exposure helper is pinned by code hash and read by no call: its full ABI ships for completeness.
  assert.deepEqual(exposure!.map(entry => entry.type === "function" || entry.type === "error" ? entry.name : entry.type), ["exposure", "InvalidWitness"]);
  assert.ok(tokenAbi.every(entry => entry.type === "function") && registryAbi.length === 1);
  const sources = [terms!, curve!, router!, hook!, cca!, controller!, account!, bond!, entry!];
  for (const entry of oxleyRevertAbi) assert.ok(sources.some(abi => matches(entry, abi)), entry.name);
});
test("the Gen10 build is the one the typed ABIs describe: the launch-scaled curve market, the trade move limit and the exact-duration launch", () => {
  const curve = full("curve") as readonly { type: string; name?: string; outputs?: readonly { components?: readonly { name: string }[] }[] }[];
  const market = curve.find(entry => entry.type === "function" && entry.name === "market");
  assert.deepEqual(market?.outputs?.[0]?.components?.map(field => field.name), ["coin", "creator", "activatedAt", "active", "position", "priceOffsetWad", "priceScaleWad", "curveInventory", "curveCapital"]);
  assert.ok(curve.some(entry => entry.type === "error" && entry.name === "TradeMoveLimit"));
  const names = (name: string, type: string) => (full(name) as readonly { type: string; name?: string }[]).filter(entry => entry.type === type).map(entry => entry.name);
  assert.ok(names("creator-account", "function").includes("launchAuctionWithCommitmentAndExactDuration"));
  assert.ok(!names("creator-account", "function").includes("launchAuctionWithCommitmentAndDuration"));
  assert.deepEqual(names("creator-account-factory", "function").sort(), ["accountFor", "auctionController", "bondEscrow", "createAccountForDraft", "handoverAdmin", "isAccount"]);
});
test("the minimum raise views are exported from every entry point and are exactly the two controller getters", () => {
  assert.deepEqual(launchMinimumRaiseAbi.map(item => [item.type, item.name, item.stateMutability]), [["function", "minimumRaise", "view"], ["function", "minimumGrossRaise", "view"]]);
  assert.equal(fromIndex, launchMinimumRaiseAbi); assert.equal(fromAuctions, launchMinimumRaiseAbi); assert.equal(fromLaunch, launchMinimumRaiseAbi);
});
test("every exported path exists and the changelog and README describe the released version", () => {
  for (const [path, target] of Object.entries(pkg.exports as Record<string, unknown>)) {
    for (const file of typeof target === "string" ? [target] : [] as string[]) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${path} -> ${file}`);
  }
  assert.equal(pkg.version, "0.7.0-next.1");
  // An "Unreleased" section may sit above the released version's section.
  assert.match(read("CHANGELOG.md"), new RegExp(`^# Changelog\\n\\n(?:## Unreleased\\n[\\s\\S]*?\\n\\n)?## ${pkg.version.replace(/\./g, "\\.")} - `));
  assert.match(read("README.md"), new RegExp(`version \`${pkg.version.replace(/\./g, "\\.")}\``));
});
