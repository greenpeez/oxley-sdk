import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root] = process.argv.slice(2);
assert.ok(root, "Supply the retained flat-fee contract build directory");
const sha = data => createHash("sha256").update(data).digest("hex");
const evidence = [];
for (const [name, path, expected] of [
  ["ElysiumCreatorAccountFactory", "deployment/releases/flat-fee-7006d7889ab293d3/artifacts/ElysiumCreatorAccountFactory.sol/ElysiumCreatorAccountFactory.json",
    "4577334ff3df85cbe209ca997190a8fd3293c6a7894f813ee9de723b3501bbfa"],
  ["ElysiumCreatorAccount", "out-flat-fee-20261008/ElysiumCreatorAccount.sol/ElysiumCreatorAccount.json",
    "a4e4d0d768b17f21316a3ae32fb2159b5257d840783229635306386c5a4e9497"],
]) {
  const raw = readFileSync(join(root, path)); assert.equal(sha(raw), expected);
  const artifact = JSON.parse(raw), abi = JSON.stringify(artifact.abi, null, 2) + "\n";
  const fixture = JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object,
    methodIdentifiers: artifact.methodIdentifiers }) + "\n";
  writeFileSync(`abis/${name}.json`, abi);
  writeFileSync(`test/fixtures/${name}.json`, fixture);
  evidence.push({ name, originalArtifactSha256: expected, abiSha256: sha(abi), fixtureSha256: sha(fixture) });
}
writeFileSync("docs/launch-artifacts.json", JSON.stringify({ releaseId: "elysium-auctions-flat-fee-7006d7889ab293d3", evidence }, null, 2) + "\n");

// Retain the actual auction graph for offline EVM tests, with release-manifest artifact integrity checks.
const manifest = JSON.parse(readFileSync(join(root, "deployment/releases/flat-fee-7006d7889ab293d3/canonical-manifest.json")));
const { authorizedGraphRecipe } = await import(pathToFileURL(join(root, "deployment/authorization-recipes-v1.mjs")));
const recipe = authorizedGraphRecipe("auction"), artifacts = {};
for (const step of recipe.filter(s => s.kind === "create")) {
  const path = join(root, "deployment/releases/flat-fee-7006d7889ab293d3/artifacts", step.artifact);
  const raw = readFileSync(path), artifact = JSON.parse(raw);
  assert.equal(sha(raw), manifest.runtimes.find(r => r.role === step.role).artifactSha256, step.role);
  artifacts[step.artifact] = { abi: artifact.abi, bytecode: artifact.bytecode.object, originalArtifactSha256: sha(raw) };
}
const graph = JSON.stringify({ recipe, artifacts }) + "\n";
writeFileSync("test/fixtures/LaunchGraph.json", graph);
writeFileSync("docs/launch-artifacts.json", JSON.stringify({ releaseId: "elysium-auctions-flat-fee-7006d7889ab293d3",
  evidence, graphFixtureSha256: sha(graph) }, null, 2) + "\n");
