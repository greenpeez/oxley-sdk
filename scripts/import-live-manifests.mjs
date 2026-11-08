import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import console from "node:console";
import { manifestFor, mapProductionManifest } from "./deployment-manifests.mjs";

// Rebuilds the Gen3, Gen8 and Gen10 testnet manifests, their full ABIs and docs/live-artifacts.json from the reviewed deployment records.
// Usage: node scripts/import-live-manifests.mjs <deployment-records-root> <application-worktree> [--gen9-record=<path under the records root> --gen9-sha256=<hex>]
// Gen9 (the Gen8 stack plus a launch floor cap) is imported only when its reviewed record is named together with that record's sha256; without
// both flags deployments/elysium-testnet-gen9.json is neither written nor touched. Gen10 (the Gen9 stack with a $30,000 net minimum raise) is
// pinned below like Gen8: its record is read from the records root and must match its sha256.
const flags = process.argv.slice(2).filter(arg => arg.startsWith("--")), [records, app] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const flag = name => flags.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(records && app, "Supply the deployment records directory and the application worktree");
const gen9Record = flag("gen9-record"), gen9Sha = flag("gen9-sha256");
assert.ok(!gen9Record === !gen9Sha, "--gen9-record and --gen9-sha256 are supplied together");
const sha = data => createHash("sha256").update(data).digest("hex");
const lower = value => JSON.parse(JSON.stringify(value), (_, item) => typeof item === "string" && /^0x[0-9a-fA-F]{40}$/.test(item) ? item.toLowerCase() : item);
const source = (root, path, expected) => { const raw = readFileSync(join(root, path)); assert.equal(sha(raw), expected, path); return raw; };

// Gen3: the reviewed SDK-shaped deployment plus generation, status and the hoisted terms registry pin.
const gen3Path = "gen3-live-20261021/sdk-deployment.json", gen3Sha = "0be0dc1b224112243309094730b7fc7fe5babdc49e1d3f11e7be7d3c9edc668a";
const g3 = lower(JSON.parse(source(records, gen3Path, gen3Sha)));
const gen3 = { schemaVersion: g3.schemaVersion, releaseId: g3.releaseId, generation: "gen3", status: "live", chainId: g3.chainId, network: g3.network,
  startBlock: g3.startBlock, curve: g3.curve, registry: g3.registry, quoteToken: g3.quoteToken, auctionController: g3.auctionController,
  termsRegistry: g3.gen3.termsRegistry, launchBindings: g3.launchBindings, auctionBindings: g3.auctionBindings, gen3: g3.gen3 };
writeFileSync("deployments/elysium-testnet-gen3.json", JSON.stringify(gen3, null, 2) + "\n");

// Gen8, Gen9 and Gen10 share one mapping: the production schema-3 manifest to the SDK's deployment shape (only the roles the SDK reads are pinned).
// Gen10's record is the owner's live deployment record of 2026-11-06 (release elysium-auctions-gen10-1fa4ef2a98fd14ed).
const familyRecords = [{ generation: "gen8", path: "gen8-live-20261029/gen8-deployment.json", sha: "e1d46ed2c5f257483c2a4822e1c0cc1968f61861be81145484c20625752398b9" }];
if (gen9Record) familyRecords.push({ generation: "gen9", path: gen9Record, sha: gen9Sha });
else console.log("gen9: skipped (no --gen9-record); deployments/elysium-testnet-gen9.json is not written");
familyRecords.push({ generation: "gen10", path: "gen10-live-20261106/gen10-deployment.json", sha: "dfbbba541ecc9049b371fa6fafb0f4bb29c6ccc6ae081cadad2de4fe408d9e8f", checkedAt: "2026-11-07" });
const imported = familyRecords.map(({ generation, path, sha: expected, checkedAt }) => {
  const entry = manifestFor(generation), manifest = mapProductionManifest(entry, lower(JSON.parse(source(records, path, expected))));
  writeFileSync(entry.file, JSON.stringify(manifest, null, 2) + "\n");
  return { generation, path, sha: expected, checkedAt, manifest };
});
// Gen9 and Gen10 reuse Oxy-USDC: the same pin as Gen8's, or the record is not the Gen8 stack redeployed.
for (const { manifest } of imported.slice(1)) assert.deepEqual(manifest.quoteToken, imported[0].manifest.quoteToken, "the Oxy-USDC pin must equal Gen8's");
// Gen10 reuses Gen9's terms registry (owner decision 2026-11-06), so no wallet accepts the terms again: the pin below is Gen9's live registry
// (gen9-live-20261101/gen9-deployment.json roles.termsRegistry), and an imported Gen9 record must agree with it.
const GEN9_TERMS_REGISTRY = { address: "0x94c8c7203e2a01e37f104fa6cbe00382642c084d", runtimeCodeHash: "0x2aebc67f8fb67759321d1367cf8306bac96b66527b719f2598976994a87f052d" };
for (const { generation, manifest } of imported.slice(1)) assert.deepEqual(manifest.termsRegistry, GEN9_TERMS_REGISTRY, `${generation} must name Gen9's terms registry`);

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
    ...imported.map(({ generation, path, sha: expected, checkedAt }) => ({ file: manifestFor(generation).file, sourcePath: path, sourceSha256: expected, schemaVersion: 3,
      ...checkedAt ? { checkedAt } : {},
      mapping: "roles curve, registry, quoteToken, controller, termsRegistry, bidRouter, adapter, bidHook and exposureHelper; bidRules verbatim" })),
  ],
  evidence }, null, 2) + "\n");
