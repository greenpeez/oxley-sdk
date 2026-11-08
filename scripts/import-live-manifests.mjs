import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { MANIFEST, mapProductionManifest } from "./deployment-manifests.mjs";

// Rebuilds the testnet manifest, the full ABIs and docs/live-artifacts.json from the reviewed deployment record and the application worktree.
// Usage: node scripts/import-live-manifests.mjs <deployment-records-root> <application-worktree>
// The record is the owner's live deployment record of 2026-11-06 (release elysium-auctions-gen10-1fa4ef2a98fd14ed); it must match its sha256.
const [records, app] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
assert.ok(records && app, "Supply the deployment records directory and the application worktree");
const sha = data => createHash("sha256").update(data).digest("hex");
const lower = value => JSON.parse(JSON.stringify(value), (_, item) => typeof item === "string" && /^0x[0-9a-fA-F]{40}$/.test(item) ? item.toLowerCase() : item);
const source = (root, path, expected) => { const raw = readFileSync(join(root, path)); assert.equal(sha(raw), expected, path); return raw; };

const RECORD = { path: "gen10-live-20261106/gen10-deployment.json", sha: "dfbbba541ecc9049b371fa6fafb0f4bb29c6ccc6ae081cadad2de4fe408d9e8f", checkedAt: "2026-11-07" };
const manifest = mapProductionManifest(lower(JSON.parse(source(records, RECORD.path, RECORD.sha))));
writeFileSync(MANIFEST.file, JSON.stringify(manifest, null, 2) + "\n");
// The terms registry is the live one that the curve and the Dynamic Bids hook enforce.
const TERMS_REGISTRY = { address: "0x94c8c7203e2a01e37f104fa6cbe00382642c084d", runtimeCodeHash: "0x2aebc67f8fb67759321d1367cf8306bac96b66527b719f2598976994a87f052d" };
assert.deepEqual(manifest.termsRegistry, TERMS_REGISTRY, "the manifest must name the live terms registry");

// [contract, role, file, application artifact path, is a forge artifact (ABI under .abi), artifact sha256, Solidity source path]
const forge = name => `.tooling/verification/gen8-ast/out/${name}.sol/${name}.json`;
const abis = [
  ["OxleyTermsRegistry", "termsRegistry", "terms-registry", "contracts/v2/abis/OxleyTermsRegistry.json", false,
    "85316b6b35e0312531c3ca0ffa0ec72ac6e37338deaa30bc6de33af10b865e08", "packages/elysium-contracts-vnext/src/gen3/OxleyTermsRegistry.sol"],
  ["ElysiumCurveGen8", "curve", "curve", forge("ElysiumCurveGen8"), true,
    "17b0cf8248897dc8c4ea03f231b90e626ea1834c46c92b0a656ce0f6875dccac", "packages/elysium-contracts-vnext/src/gen8/ElysiumCurveGen8.sol"],
  ["ElysiumCcaBidRouterGen8", "bidRouter", "bid-router", forge("ElysiumCcaBidRouterGen8"), true,
    "d98b63c5bfe5ae70d0f3b9fc80a09b33058a5189bcbe943a7a0f8596556a1b4c", "packages/elysium-contracts-vnext/src/gen8/ElysiumCcaBidRouterGen8.sol"],
  ["ElysiumDynamicBidHookGen8", "bidHook", "bid-hook", forge("ElysiumDynamicBidHookGen8"), true,
    "23cf849a80d15f32e811a2fd9cb557b5855680fed613ce6a9ebbb26e09cb7f00", "packages/elysium-contracts-vnext/src/gen8/ElysiumDynamicBidHookGen8.sol"],
];
const evidence = abis.map(([contract, role, name, path, artifact, artifactSha, solidity]) => {
  const parsed = JSON.parse(source(app, path, artifactSha)), abi = JSON.stringify(artifact ? parsed.abi : parsed, null, 2) + "\n";
  writeFileSync(`abis/${name}.json`, abi);
  const solidityFile = readFileSync(join(app, solidity));
  return { contract, role, file: `abis/${name}.json`, export: `@oxley/sdk/abis/${name}.json`, sourcePath: path, sourceSha256: artifactSha, abiSha256: sha(abi),
    solidityPath: solidity, soliditySha256: sha(solidityFile) };
});
writeFileSync("docs/live-artifacts.json", JSON.stringify({
  checkedAt: "2026-10-29", chainId: 99801,
  sourceRepository: { worktree: "oxley-consolidation-20261019/wt-p2", commit: "3224cc1322e37edaecd92037a0826ddc3ad0d448",
    note: "The router and hook sources that were deployed are uncommitted working-tree files at that commit; their sha256 is recorded below. The reviewed release redeploys that contract stack, so its runtime ABIs are these." },
  deployments: [{ file: MANIFEST.file, sourcePath: RECORD.path, sourceSha256: RECORD.sha, schemaVersion: 3, checkedAt: RECORD.checkedAt,
    mapping: "roles curve, registry, quoteToken, controller, termsRegistry, bidRouter, adapter, bidHook and exposureHelper; bidRules verbatim" }],
  evidence }, null, 2) + "\n");
