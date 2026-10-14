import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import solc from "solc";
import console from "node:console";

const root = "test/contracts";
const sources = {};
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if (entry.name.endsWith(".sol")) sources[relative(root, child)] = { content: readFileSync(child, "utf8") };
  }
}
collect(root);
sources["upstream/SettlerAbstract.sol"] = sources["SettlerAbstract.sol"];
sources["@forge-std/interfaces/IERC20.sol"] = sources["IERC20.sol"];
const result = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: {
  optimizer: { enabled: true, runs: 2000 }, viaIR: true, evmVersion: "osaka",
  outputSelection: { "BasicExecutor.sol": { "BasicExecutor": ["abi", "evm.bytecode.object"] } },
} })));
const errors = (result.errors ?? []).filter(error => error.severity === "error");
if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join("\n"));
const artifact = result.contracts["BasicExecutor.sol"].BasicExecutor;
writeFileSync("test/fixtures/BasicExecutor.json", JSON.stringify({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` }) + "\n");
console.log(`Built BASIC test executor with solc ${solc.version()}`);
