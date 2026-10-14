import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

const [root, erc20Interface] = process.argv.slice(2);
if (!root || !erc20Interface) throw new Error("Supply pinned 0x checkout and forge-std IERC20.sol");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const names = ["core/Basic.sol", "core/Constants.sol", "core/SettlerErrors.sol", "vendor/SafeTransferLib.sol",
  "utils/Panic.sol", "utils/Revert.sol", "utils/UnsafeMath.sol", "utils/512Math.sol", "vendor/Clz.sol",
  "utils/Ternary.sol", "utils/FastLogic.sol", "vendor/Sqrt.sol"];
const evidence = [];
for (const name of names) {
  const content = readFileSync(resolve(root, "src", name));
  const target = `test/contracts/upstream/${name}`;
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  evidence.push({ path: name, sha256: createHash("sha256").update(content).digest("hex") });
}
writeFileSync("test/contracts/IERC20.sol", readFileSync(erc20Interface));
writeFileSync("test/contracts/upstream/provenance.json", JSON.stringify({ repository: "https://github.com/0xProject/0x-settler", commit,
  boundary: "Unmodified BASIC implementation and its utilities; test base replaces abstract funding/context dependencies. Not a full Settler acceptance test.", evidence }, null, 2) + "\n");
