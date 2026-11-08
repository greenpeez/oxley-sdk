import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

// Test scaffolding for the local EVM suite: the fee router the bid router reports to, and a plain ERC-20.
const root = process.argv[2];
if (!root) throw new Error("Supply the retained out-flat-fee-20261008 artifact directory");
const targets = [
  ["ElysiumFeeRouterVNext.sol", "ElysiumFeeRouterVNext"],
  ["ReserveCurveVNext.t.sol", "IntegrationToken"],
];
const evidence = [];
mkdirSync("test/fixtures", { recursive: true });
for (const [source, name] of targets) {
  const raw = readFileSync(resolve(root, source, `${name}.json`));
  const artifact = JSON.parse(raw);
  const fixture = JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  writeFileSync(`test/fixtures/${name}.json`, fixture + "\n");
  evidence.push({ name, originalArtifactSha256: createHash("sha256").update(raw).digest("hex"),
    fixtureSha256: createHash("sha256").update(fixture + "\n").digest("hex") });
}
writeFileSync("test/fixtures/provenance.json", JSON.stringify({ build: "retained 2026-10-08 build; Solidity 0.8.26 Cancun optimizer 200", evidence }, null, 2) + "\n");
