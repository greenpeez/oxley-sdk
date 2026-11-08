import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { keccak256 } from "viem";
import { MANIFEST, mapProductionManifest } from "./deployment-manifests.mjs";

// Rebuilds the testnet manifest, the full compiler ABIs and docs/live-artifacts.json from the reviewed deployment record and the application worktree.
// Usage: node scripts/import-live-manifests.mjs <deployment-records-root> <application-worktree>
// The record is the owner's live deployment record of 2026-11-06 (release elysium-auctions-gen10-1fa4ef2a98fd14ed); it must match its sha256.
//
// Which build the ABIs come from is proved here, not assumed. The record names `compiledGraphSha256`, the identity of the compiler job that built the
// deployed contracts. The compiled graph file in the worktree must hash to it (the same canonical-JSON rule the deploy tooling uses), every source it lists
// must still be byte-identical in the worktree, and the forge artifact each ABI is taken from must reproduce the graph's creation-code and runtime-template
// keccak256 and carry the graph's ABI. `scripts/check-abis-testnet.ts` then compares the chain's code with the same templates.
const [records, app] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
assert.ok(records && app, "Supply the deployment records directory and the application worktree");
const sha = data => createHash("sha256").update(data).digest("hex");
const lower = value => JSON.parse(JSON.stringify(value), (_, item) => typeof item === "string" && /^0x[0-9a-fA-F]{40}$/.test(item) ? item.toLowerCase() : item);
const source = (root, path, expected) => { const raw = readFileSync(join(root, path)); assert.equal(sha(raw), expected, path); return raw; };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;

const RECORD = { path: "gen10-live-20261106/gen10-deployment.json", sha: "dfbbba541ecc9049b371fa6fafb0f4bb29c6ccc6ae081cadad2de4fe408d9e8f", checkedAt: "2026-11-07" };
const record = lower(JSON.parse(source(records, RECORD.path, RECORD.sha)));
const manifest = mapProductionManifest(record);
writeFileSync(MANIFEST.file, JSON.stringify(manifest, null, 2) + "\n");
// The terms registry is the live one that the curve and the Dynamic Bids hook enforce.
const TERMS_REGISTRY = { address: "0x94c8c7203e2a01e37f104fa6cbe00382642c084d", runtimeCodeHash: "0x2aebc67f8fb67759321d1367cf8306bac96b66527b719f2598976994a87f052d" };
assert.deepEqual(manifest.termsRegistry, TERMS_REGISTRY, "the manifest must name the live terms registry");

// The compiler job that produced the deployed contracts: its file hash is pinned here, its identity is the record's compiledGraphSha256.
const PACKAGE = "packages/elysium-contracts-vnext", GRAPH = "docs/elysium/gen10/gen10-compiled-graph.json";
const GRAPH_FILE_SHA = "31684aefe95e60b4842e75ff8a7fe1312e3cb9c6516f9d009d14837543503eb9";
const SOURCE_COMMIT = "4406015c8122ba0cd356d12bbf627ec3b7c2b982";
const graphRaw = source(app, GRAPH, GRAPH_FILE_SHA), graph = JSON.parse(graphRaw);
const { compiledGraphSha256, ...graphBody } = graph;
assert.equal(sha(JSON.stringify(canonical(graphBody))), compiledGraphSha256, "the compiled graph must hash to its own identity");
assert.equal(compiledGraphSha256, record.compiledGraphSha256, "the compiled graph must be the one the deployment record names");
assert.equal(graph.generation, "gen10"); assert.equal(graph.chainId, record.chainId);
for (const item of graph.sources) assert.equal(sha(readFileSync(join(app, PACKAGE, item.path))), item.sha256, `source changed since the deployed build: ${item.path}`);

// [file, role]: every contract of the graph that the SDK touches. The quote token is the production Oxy-USDC, an external contract with no Oxley build.
const abis = [
  ["terms-registry", "termsRegistry"], ["curve", "curve"], ["bid-router", "bidRouter"], ["bid-hook", "bidHook"], ["exposure-helper", "exposureHelper"],
  ["auction-controller", "controller"], ["adapter", "adapter"], ["registry", "registry"], ["bond-escrow", "bondEscrow"], ["entry-controller", "entryController"],
  ["creator-account-factory", "creatorAccountFactory"], ["creator-account", "creatorAccount"],
];
const slots = refs => Object.values(refs ?? {}).flat().map(({ start, length }) => [start, length]).sort((a, b) => a[0] - b[0]);
const evidence = abis.map(([name, role]) => {
  const built = graph.contracts.find(item => item.role === role);
  assert.ok(built, role);
  const path = `${PACKAGE}/out/${built.source.split("/").pop()}/${built.contract}.json`, artifactRaw = readFileSync(join(app, path)), artifact = JSON.parse(artifactRaw);
  assert.equal(keccak256(`0x${artifact.bytecode.object.replace(/^0x/, "")}`), built.creationCodeKeccak256, `${role}: creation code differs from the deployed build`);
  assert.equal(keccak256(`0x${artifact.deployedBytecode.object.replace(/^0x/, "")}`), built.runtimeTemplateKeccak256, `${role}: runtime template differs from the deployed build`);
  assert.equal(JSON.stringify(canonical(artifact.abi)), JSON.stringify(canonical(built.abi)), `${role}: ABI differs from the compiled graph`);
  assert.deepEqual(slots(artifact.deployedBytecode.immutableReferences), slots(built.immutableReferences), `${role}: immutable slots differ`);
  const abi = JSON.stringify(artifact.abi, null, 2) + "\n";
  writeFileSync(`abis/${name}.json`, abi);
  const deployed = record.roles[role];
  const solidityPath = `${PACKAGE}/${built.source}`;
  const row = { contract: built.contract, role, file: `abis/${name}.json`, export: `@oxley/sdk/abis/${name}.json`, sourcePath: path, sourceSha256: sha(artifactRaw),
    abiSha256: sha(abi), solidityPath, soliditySha256: sha(readFileSync(join(app, solidityPath))), creationCodeKeccak256: built.creationCodeKeccak256,
    runtimeTemplateKeccak256: built.runtimeTemplateKeccak256, runtimeBytes: built.runtimeBytes, immutableReferences: slots(built.immutableReferences) };
  if (deployed) {
    // A contract without immutables is its own template: the pinned runtime hash must equal it, with no chain read.
    if (row.immutableReferences.length === 0) assert.equal(deployed.runtimeCodeHash, built.runtimeTemplateKeccak256, `${role}: pinned hash is not the template`);
    row.deployed = { address: deployed.address, pinnedRuntimeCodeHash: deployed.runtimeCodeHash };
  } else row.deployed = null;
  return row;
});
const text = JSON.stringify({
  checkedAt: "2026-11-08", chainId: 99801,
  release: { releaseId: record.releaseId, planSha256: record.planSha256, compiledGraphSha256 },
  build: {
    compiler: graph.compiler,
    settings: { evmVersion: graph.settings.evmVersion, optimizer: graph.settings.optimizer, viaIR: graph.settings.viaIR, metadata: graph.settings.metadata },
    compiledGraph: { path: GRAPH, fileSha256: GRAPH_FILE_SHA, contracts: graph.contracts.length, sources: graph.sources.length },
    sourceRepository: { worktree: "oxley-consolidation-20261019/wt-p2", commit: SOURCE_COMMIT,
      note: "The commit that holds the Gen10 compiled graph. All of the graph's sources are byte-identical in the worktree the ABIs were read from (checked by the importer). Gen10 is the Gen9 stack with a $30,000 net minimum raise in the controller's constructor." },
    method: "Each ABI is the forge artifact's `abi`. The importer asserts that the artifact's creation code and runtime template hash to the compiled graph's creationCodeKeccak256 and runtimeTemplateKeccak256, that its ABI and immutable slots equal the graph's, and that the graph hashes to the record's compiledGraphSha256. A deployed contract's runtime code with the immutable slots zeroed hashes to runtimeTemplateKeccak256 (scripts/check-abis-testnet.ts); a contract with no immutable slots has runtimeTemplateKeccak256 equal to its pinned runtime code hash. The creator account is deployed by the factory, so it has no address of its own: the check reads accounts the factory created.",
  },
  deployments: [{ file: MANIFEST.file, sourcePath: RECORD.path, sourceSha256: RECORD.sha, schemaVersion: 3, checkedAt: RECORD.checkedAt,
    mapping: "roles curve, registry, quoteToken, controller, termsRegistry, bidRouter, adapter, bidHook, exposureHelper, creatorAccountFactory, entryController and bondEscrow; bidRules verbatim; launchBindings costs from LAUNCH_COSTS (deployment-manifests.mjs)" }],
  evidence }, null, 2).replace(/\[\s+(\d+),\s+(\d+)\s+\]/g, "[$1, $2]") + "\n";
writeFileSync("docs/live-artifacts.json", text);
