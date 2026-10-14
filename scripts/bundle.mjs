import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";

const root = fileURLToPath(new URL("..", import.meta.url));
assert.ok(process.argv[2], "Supply a new provider bundle output directory");
const output = resolve(process.argv[2]);
assert.ok(!existsSync(output) && !existsSync(`${output}.tar.gz`), "Output already exists; choose a new destination");
// Pack invokes the library build; copy only the public distribution materials.
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8" }));
mkdirSync(output, { recursive: true });
for (const path of [pack.filename, "README.md", "LICENSE", "docs", "abis", "deployments", "examples"]) {
  cpSync(join(root, path), join(output, path), { recursive: true });
}
function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(join(directory, entry.name), path) : [path];
  }).sort();
}
const checksums = files(output).map(path => `${createHash("sha256").update(readFileSync(join(output, path))).digest("hex")}  ${path}`);
writeFileSync(join(output, "SHA256SUMS"), checksums.join("\n") + "\n");
execFileSync("tar", ["-czf", `${output}.tar.gz`, "-C", dirname(output), basename(output)],
  { env: { ...process.env, COPYFILE_DISABLE: "1" } });
console.log(JSON.stringify({ bundle: `${output}.tar.gz`, package: join(output, pack.filename),
  handoff: join(output, "docs/provider-handoff.md"), sha256: createHash("sha256")
    .update(readFileSync(`${output}.tar.gz`)).digest("hex") }, null, 2));
