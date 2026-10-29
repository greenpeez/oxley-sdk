import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Rebuilds the Gen3 and Gen8 testnet manifests, their full ABIs and docs/live-artifacts.json from the reviewed deployment records.
// Usage: node scripts/import-live-manifests.mjs <deployment-records-root> <application-worktree>
const [records, app] = process.argv.slice(2);
assert.ok(records && app, "Supply the deployment records directory and the application worktree");
const sha = data => createHash("sha256").update(data).digest("hex");
const lower = value => JSON.parse(JSON.stringify(value), (_, item) => typeof item === "string" && /^0x[0-9a-fA-F]{40}$/.test(item) ? item.toLowerCase() : item);
const source = (root, path, expected) => { const raw = readFileSync(join(root, path)); assert.equal(sha(raw), expected, path); return raw; };
const pin = role => ({ address: role.address, runtimeCodeHash: role.runtimeCodeHash });

// Gen3: the reviewed SDK-shaped deployment plus generation, status and the hoisted terms registry pin.
const gen3Path = "gen3-live-20261021/sdk-deployment.json", gen3Sha = "0be0dc1b224112243309094730b7fc7fe5babdc49e1d3f11e7be7d3c9edc668a";
const g3 = lower(JSON.parse(source(records, gen3Path, gen3Sha)));
const gen3 = { schemaVersion: g3.schemaVersion, releaseId: g3.releaseId, generation: "gen3", status: "live", chainId: g3.chainId, network: g3.network,
  startBlock: g3.startBlock, curve: g3.curve, registry: g3.registry, quoteToken: g3.quoteToken, auctionController: g3.auctionController,
  termsRegistry: g3.gen3.termsRegistry, launchBindings: g3.launchBindings, auctionBindings: g3.auctionBindings, gen3: g3.gen3 };
writeFileSync("deployments/elysium-testnet-gen3.json", JSON.stringify(gen3, null, 2) + "\n");

// Gen8: the production schema-3 manifest mapped to the SDK's deployment shape (only the roles the SDK reads are pinned).
const gen8Path = "gen8-live-20261029/gen8-deployment.json", gen8Sha = "e1d46ed2c5f257483c2a4822e1c0cc1968f61861be81145484c20625752398b9";
const m = lower(JSON.parse(source(records, gen8Path, gen8Sha))), r = m.roles;
assert.equal(m.schemaVersion, 3); assert.equal(m.mode, "production"); assert.equal(m.activated, true);
const gen8 = { schemaVersion: 1, releaseId: m.releaseId, generation: "gen8", status: "live", chainId: m.chainId, network: "testnet", startBlock: m.startBlock,
  curve: pin(r.curve), registry: pin(r.registry), quoteToken: { ...pin(r.quoteToken), symbol: "Oxy-USDC", decimals: 6 }, auctionController: r.controller.address,
  termsRegistry: pin(r.termsRegistry), auctionBindings: { controllerRuntimeCodeHash: r.controller.runtimeCodeHash, bidRouter: pin(r.bidRouter),
    adapter: pin(r.adapter), bidHook: pin(r.bidHook), exposureHelper: pin(r.exposureHelper) }, bidRules: m.bidRules };
writeFileSync("deployments/elysium-testnet-gen8.json", JSON.stringify(gen8, null, 2) + "\n");

const forge = name => `.tooling/verification/gen8-ast/out/${name}.sol/${name}.json`;
const abis = [
  ["ElysiumReserveCurveGen3", "gen3Curve", "@oxley/sdk/abis/gen3/curve.json", "contracts/v2/abis/ElysiumReserveCurveGen3.json", false,
    "132fe49e63e1f7653a8cf08d5b9977546a089b7624af1025b02d7cad368748f1", "packages/elysium-contracts-vnext/src/gen3/ElysiumReserveCurveGen3.sol"],
  ["OxleyTermsRegistry", "termsRegistry", "@oxley/sdk/abis/terms-registry.json", "contracts/v2/abis/OxleyTermsRegistry.json", false,
    "85316b6b35e0312531c3ca0ffa0ec72ac6e37338deaa30bc6de33af10b865e08", "packages/elysium-contracts-vnext/src/gen3/OxleyTermsRegistry.sol"],
  ["ElysiumCurveGen8", "gen8Curve", "@oxley/sdk/abis/gen8/curve.json", forge("ElysiumCurveGen8"), true,
    "17b0cf8248897dc8c4ea03f231b90e626ea1834c46c92b0a656ce0f6875dccac", "packages/elysium-contracts-vnext/src/gen8/ElysiumCurveGen8.sol"],
  ["ElysiumCcaBidRouterGen8", "gen8BidRouter", "@oxley/sdk/abis/gen8/bid-router.json", forge("ElysiumCcaBidRouterGen8"), true,
    "d98b63c5bfe5ae70d0f3b9fc80a09b33058a5189bcbe943a7a0f8596556a1b4c", "packages/elysium-contracts-vnext/src/gen8/ElysiumCcaBidRouterGen8.sol"],
  ["ElysiumDynamicBidHookGen8", "gen8BidHook", "@oxley/sdk/abis/gen8/bid-hook.json", forge("ElysiumDynamicBidHookGen8"), true,
    "23cf849a80d15f32e811a2fd9cb557b5855680fed613ce6a9ebbb26e09cb7f00", "packages/elysium-contracts-vnext/src/gen8/ElysiumDynamicBidHookGen8.sol"],
];
const evidence = abis.map(([name, role, exportPath, path, artifact, artifactSha, solidity]) => {
  const parsed = JSON.parse(source(app, path, artifactSha)), abi = JSON.stringify(artifact ? parsed.abi : parsed, null, 2) + "\n";
  writeFileSync(`abis/${name}.json`, abi);
  const solidityFile = readFileSync(join(app, solidity));
  return { name, role, export: exportPath, sourcePath: path, sourceSha256: artifactSha, abiSha256: sha(abi), solidityPath: solidity, soliditySha256: sha(solidityFile) };
});
writeFileSync("docs/live-artifacts.json", JSON.stringify({
  checkedAt: "2026-10-29", chainId: 99801,
  sourceRepository: { worktree: "oxley-consolidation-20261019/wt-p2", commit: "3224cc1322e37edaecd92037a0826ddc3ad0d448",
    note: "The Gen8 hook, exposure helper and router sources that were deployed are uncommitted working-tree files at that commit; their sha256 is recorded below." },
  deployments: [
    { file: "deployments/elysium-testnet-gen3.json", sourcePath: gen3Path, sourceSha256: gen3Sha, addedFields: ["generation", "status", "termsRegistry"] },
    { file: "deployments/elysium-testnet-gen8.json", sourcePath: gen8Path, sourceSha256: gen8Sha, schemaVersion: 3, mapping: "roles curve, registry, quoteToken, controller, termsRegistry, bidRouter, adapter, bidHook and exposureHelper; bidRules verbatim" },
  ],
  evidence }, null, 2) + "\n");
