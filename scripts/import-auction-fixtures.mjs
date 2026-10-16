import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [release, vendor, testBuild] = process.argv.slice(2);
assert.ok(release && vendor && testBuild, "Supply retained release, recovered vendor and test build directories");
const specs = [
  ["ElysiumBondedCcaLaunchControllerVNext", "80978152b53f3f7b55b4461ac6abe4fb20e4e0544cbc34ca20cb31cf87eaef8a"],
  ["ElysiumCcaBidRouterVNext", "cc805b58f63bb319318c038daaadee8b898139838bf9e66921463f8e07af6a16"],
  ["ElysiumUniswapCcaAdapter", "d8ad283e89d4d8852210512b5f6ad9072fb687e7cd76f842a25c9fa4aacd4a09"],
  ["ContinuousClearingAuction", "8d6e125546ac976c6fcd2003f458906f4742c6dfd5794fdc84d24aec37d3f0ef"],
];
const sha = data => createHash("sha256").update(data).digest("hex");
const evidence = [];
for (const [name, originalArtifactSha256] of specs) {
  const raw = readFileSync(name === "ContinuousClearingAuction" ? join(vendor, name + ".json")
    : join(release, "artifacts", name + ".sol", name + ".json"));
  assert.equal(sha(raw), originalArtifactSha256, name);
  const artifact = JSON.parse(raw);
  const abi = JSON.stringify(artifact.abi, null, 2) + "\n";
  const fixture = JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object,
    methodIdentifiers: artifact.methodIdentifiers }) + "\n";
  writeFileSync(`abis/${name}.json`, abi);
  writeFileSync(`test/fixtures/${name}.json`, fixture);
  evidence.push({ name, originalArtifactSha256, abiSha256: sha(abi), fixtureSha256: sha(fixture) });
}
writeFileSync("docs/auction-artifacts.json", JSON.stringify({
  releaseId: "elysium-auctions-flat-fee-7006d7889ab293d3", evidence,
}, null, 2) + "\n");
const permit = JSON.parse(readFileSync(join(vendor, "permit2-runtime.json")));
writeFileSync("test/fixtures/Permit2Runtime.json", JSON.stringify({ code: permit.code, hash: permit.hash }) + "\n");
for (const [name, path, expected] of [
  ["ContinuousClearingAuctionFactory", join(vendor, "ContinuousClearingAuctionFactory.json"),
    "59a6438986fed260a6e82817e5bf0f27f49e60dbe26fab5a0cf96a066289ac15"],
  ["BidMarket", join(testBuild, "CcaBidRouterVNext.t.sol/BidMarket.json"),
    "317c4a875b45cb240650e30a6721ad26ec0bedd607da72222d9145e3ecd2da10"],
]) {
  const raw = readFileSync(path); assert.equal(sha(raw), expected);
  const item = JSON.parse(raw);
  writeFileSync(`test/fixtures/${name}.json`, JSON.stringify({ abi: item.abi, bytecode: item.bytecode.object }) + "\n");
}
