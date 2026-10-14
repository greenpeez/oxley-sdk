import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

const root = process.argv[2];
if (!root) throw new Error("Supply the retained VNext out-flat-fee-20261008 artifact directory");
const targets = [
  ["ElysiumReserveCurveVNext.sol", "ElysiumReserveCurveVNext"],
  ["ElysiumFeeRouterVNext.sol", "ElysiumFeeRouterVNext"],
  ["ElysiumListingVault.sol", "ElysiumListingVault"],
  ["ElysiumDealRegistry.sol", "ElysiumDealRegistry"],
  ["ElysiumEntryController.sol", "ElysiumEntryController"],
  ...["IntegrationToken", "IntegrationPrice", "IntegrationRebate", "IntegrationReserve"].map(n => ["ReserveCurveVNext.t.sol", n]),
];
const evidence = [];
mkdirSync("test/fixtures", { recursive: true });
mkdirSync("abis", { recursive: true });
for (const [source, name] of targets) {
  const raw = readFileSync(resolve(root, source, `${name}.json`));
  const artifact = JSON.parse(raw);
  const fixture = JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  writeFileSync(`test/fixtures/${name}.json`, fixture + "\n");
  evidence.push({ name, originalArtifactSha256: createHash("sha256").update(raw).digest("hex"),
    fixtureSha256: createHash("sha256").update(fixture + "\n").digest("hex") });
  if (["ElysiumReserveCurveVNext", "ElysiumDealRegistry"].includes(name)) {
    writeFileSync(`abis/${name}.json`, JSON.stringify(artifact.abi, null, 2) + "\n");
  }
}
writeFileSync("test/fixtures/provenance.json", JSON.stringify({ build: "VNext flat-fee 2026-10-08; Solidity 0.8.26 Cancun optimizer 200", evidence }, null, 2) + "\n");
