import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEN8_FAMILY, GEN8_FAMILY_IDS, GEN9_MAX_FLOOR_PRICE_WAD, deploymentGeneration, gen8FamilyMember, gen9TestnetDeployment,
  isGen8Family, OxleyError, parseDeployment, testnetDeployments, type DeploymentGeneration, type Gen8FamilyId } from "../src/index.js";
import { hasOpeningSurcharge, hasTradingGate, requiresTerms } from "../src/curve-profile.js";
import { GEN8_FAMILY_NAMES } from "../src/gen8-family.js";
import { BASES, gen9Fixture, manifest, read } from "./support/chain.js";
import { scripts } from "./support/manifests.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const gen8File = () => JSON.parse(read("deployments/elysium-testnet-gen8.json")) as Record<string, any>;
const root = new URL("../", import.meta.url);

test("the Gen8 family table lists gen8 and gen9, each with its own identity and only Gen9 with a floor cap", () => {
  assert.deepEqual([...GEN8_FAMILY_IDS], ["gen8", "gen9"]);
  assert.deepEqual(Object.keys(GEN8_FAMILY), [...GEN8_FAMILY_IDS]);
  const members = GEN8_FAMILY_IDS.map(id => GEN8_FAMILY[id]);
  members.forEach((member, index) => assert.equal(member.id, GEN8_FAMILY_IDS[index]));
  for (const key of ["id", "label", "releaseIdPrefix", "manifestFile"] as const) assert.equal(new Set(members.map(member => member[key])).size, members.length, key);
  assert.ok(Object.isFrozen(GEN8_FAMILY) && members.every(member => Object.isFrozen(member)));
  assert.deepEqual(members.map(member => member.maxFloorPriceWad), [undefined, 10n ** 21n]);
  assert.equal(GEN9_MAX_FLOOR_PRICE_WAD, 10n ** 21n); assert.equal(GEN8_FAMILY_NAMES, "Gen8 or Gen9");
  // Every member is a DeploymentGeneration, so a manifest, a market and a quote can carry it.
  const generations: DeploymentGeneration[] = [...GEN8_FAMILY_IDS];
  assert.deepEqual(generations, ["gen8", "gen9"]);
});
test("isGen8Family accepts exactly the family and nothing inherited, foreign or malformed", () => {
  for (const id of GEN8_FAMILY_IDS) { assert.equal(isGen8Family(id), true, id); assert.equal(gen8FamilyMember(id), GEN8_FAMILY[id]); }
  for (const other of ["flat-fee", "gen2", "gen3", "gen10", "GEN8", "Gen9", "gen8 ", "", "toString", "__proto__", "constructor", undefined, null, 8, {}]) {
    assert.equal(isGen8Family(other), false, String(other)); assert.equal(gen8FamilyMember(other), undefined, String(other));
  }
  const narrowed = (generation: DeploymentGeneration): Gen8FamilyId | undefined => isGen8Family(generation) ? generation : undefined;
  assert.deepEqual(["gen8", "gen9", "gen3"].map(value => narrowed(value as DeploymentGeneration)), ["gen8", "gen9", undefined]);
});
test("validation and the curve profile treat every family member as terms-gated, gated and surcharged, and still refuse unknown ids", () => {
  for (const id of GEN8_FAMILY_IDS) {
    const deployment = manifest(id, BASES[id]);
    assert.equal(deploymentGeneration(parseDeployment(deployment)), id);
    assert.deepEqual([requiresTerms(id), hasTradingGate(id), hasOpeningSurcharge(id)], [true, true, true], id);
    const { termsRegistry: _removed, ...withoutTerms } = deployment;
    assert.throws(() => parseDeployment(withoutTerms), code("INVALID_DEPLOYMENT"), id);
  }
  assert.deepEqual([requiresTerms("gen3"), requiresTerms("gen2"), requiresTerms("flat-fee"), requiresTerms(undefined)], [true, false, false, false]);
  assert.deepEqual([hasTradingGate("flat-fee"), hasTradingGate("gen2")], [false, true]);
  for (const unknown of ["gen10", "Gen9", "gen9 ", "gen4"]) assert.throws(() => parseDeployment({ ...manifest("gen9", BASES.gen9), generation: unknown }), code("INVALID_GENERATION"), unknown);
  assert.throws(() => parseDeployment({ ...manifest("flat-fee", 0), generation: "gen2", termsRegistry: manifest("gen9", BASES.gen9).termsRegistry }), code("INVALID_DEPLOYMENT"));
  assert.equal(parseDeployment({ ...manifest("flat-fee", 0), generation: "gen2" }).generation, "gen2");
  try { parseDeployment({ ...manifest("gen9", BASES.gen9), generation: "gen10" }); assert.fail("must reject"); } catch (error) { assert.match((error as Error).message, /"gen8".*"gen9"/); }
});
test("the release scripts' manifest table agrees with the family table, and Gen9 alone is optional", () => {
  for (const id of GEN8_FAMILY_IDS) {
    const entry = scripts.manifestFor(id);
    assert.deepEqual([entry.file, entry.releaseIdPrefix, entry.generation], [GEN8_FAMILY[id].manifestFile, GEN8_FAMILY[id].releaseIdPrefix, id]);
    assert.equal(entry.exportName, `${id}TestnetDeployment`);
  }
  assert.deepEqual(scripts.MANIFESTS.map(entry => [entry.generation ?? "flat-fee", entry.required]),
    [["flat-fee", true], ["gen3", true], ["gen8", true], ["gen9", false]]);
  assert.equal(new Set(scripts.MANIFESTS.map(entry => entry.file)).size, scripts.MANIFESTS.length);
  // Every manifest file that exists is the generation its slot names.
  for (const entry of scripts.MANIFESTS.filter(item => existsSync(new URL(item.file, root)))) {
    assert.doesNotThrow(() => scripts.validateManifest(entry, JSON.parse(read(entry.file))), entry.file);
  }
});
test("a manifest must be the generation its slot names: Gen9 as Gen8 and Gen8 as Gen9 are refused", () => {
  const [gen8Slot, gen9Slot] = [scripts.manifestFor("gen8"), scripts.manifestFor("gen9")], gen8 = gen8File(), gen9 = gen9Fixture();
  assert.doesNotThrow(() => scripts.validateManifest(gen8Slot, gen8));
  assert.doesNotThrow(() => scripts.validateManifest(gen9Slot, gen9));
  assert.throws(() => scripts.validateManifest(gen8Slot, gen9), /generation must be gen8/);
  assert.throws(() => scripts.validateManifest(gen9Slot, gen8), /generation must be gen9/);
  // The right generation with the other release family's name is refused as well, and so is a wrong schema.
  assert.throws(() => scripts.validateManifest(gen9Slot, { ...gen9, releaseId: gen8.releaseId }), /releaseId must start with elysium-auctions-gen9-/);
  assert.throws(() => scripts.validateManifest(gen8Slot, { ...gen8, generation: "gen9" }), /generation must be gen8/);
  assert.throws(() => scripts.validateManifest(gen9Slot, { ...gen9, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => scripts.validateManifest(scripts.manifestFor("gen3"), JSON.parse(read("deployments/elysium-testnet.json"))), /generation must be gen3/);
});
test("the bundled Gen9 deployment is undefined and unlisted exactly while its manifest file is absent", () => {
  const present = existsSync(new URL(GEN8_FAMILY.gen9.manifestFile, root));
  const generations = testnetDeployments.map(item => deploymentGeneration(parseDeployment(item)));
  assert.deepEqual(generations, present ? ["flat-fee", "gen3", "gen8", "gen9"] : ["flat-fee", "gen3", "gen8"]);
  assert.equal(gen9TestnetDeployment === undefined, !present);
  if (present) assert.deepEqual(JSON.parse(read(GEN8_FAMILY.gen9.manifestFile)), gen9TestnetDeployment);
  assert.equal(gen9TestnetDeployment === undefined ? "absent" : parseDeployment(gen9TestnetDeployment).generation, present ? "gen9" : "absent");
});

/** A scratch copy of the embed script and the manifests it reads, so absent, present and mis-slotted Gen9 files can be tried without touching the package. */
function embedSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "oxley-embed-"));
  for (const folder of ["scripts", "deployments", "src"]) mkdirSync(join(dir, folder));
  for (const file of ["scripts/embed-deployments.mjs", "scripts/deployment-manifests.mjs", "src/testnet-deployments.ts", ...["", "-gen3", "-gen8"].map(s => `deployments/elysium-testnet${s}.json`)]) {
    copyFileSync(new URL(file, root), join(dir, file));
  }
  const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/embed-deployments.mjs", ...args], { cwd: dir, encoding: "utf8" });
  return { dir, run, put: (file: string, text: string) => writeFileSync(join(dir, file), text), generated: () => readFileSync(join(dir, "src/testnet-deployments.ts"), "utf8") };
}
test("embedding reports an absent Gen9 manifest explicitly, bundles a present one after Gen8 and refuses a mis-slotted one", () => {
  const sandbox = embedSandbox();
  try {
    const absent = sandbox.run();
    assert.equal(absent.status, 0); assert.match(absent.stderr, /elysium-testnet-gen9\.json is absent: gen9TestnetDeployment is undefined/);
    assert.match(sandbox.generated(), /export const gen9TestnetDeployment = undefined;/);
    assert.match(sandbox.generated(), /testnetDeployments = \[flatFeeTestnetDeployment, gen3TestnetDeployment, gen8TestnetDeployment\] as const;/);
    assert.equal(sandbox.run("--check").status, 0);

    const fixture = read("test/fixtures/elysium-testnet-gen9.fixture.json");
    sandbox.put("deployments/elysium-testnet-gen9.json", fixture);
    const stale = sandbox.run("--check");
    assert.equal(stale.status, 1); assert.match(stale.stderr, /stale; run npm run embed/);
    assert.equal(sandbox.run().status, 0);
    assert.match(sandbox.generated(), /export const gen9TestnetDeployment = \{/); assert.match(sandbox.generated(), /"releaseId": "elysium-auctions-gen9-fixture0000000000"/);
    assert.match(sandbox.generated(), /testnetDeployments = \[flatFeeTestnetDeployment, gen3TestnetDeployment, gen8TestnetDeployment, gen9TestnetDeployment\] as const;/);
    assert.equal(sandbox.run("--check").status, 0);

    // The Gen9 file in the Gen8 slot and the Gen8 file in the Gen9 slot both fail the run.
    const gen8 = read("deployments/elysium-testnet-gen8.json");
    sandbox.put("deployments/elysium-testnet-gen8.json", fixture);
    assert.match(sandbox.run().stderr, /elysium-testnet-gen8\.json: generation must be gen8/);
    sandbox.put("deployments/elysium-testnet-gen8.json", gen8); sandbox.put("deployments/elysium-testnet-gen9.json", gen8);
    assert.match(sandbox.run().stderr, /elysium-testnet-gen9\.json: generation must be gen9/);
    // A required manifest is never optional.
    rmSync(join(sandbox.dir, "deployments/elysium-testnet-gen8.json"));
    assert.notEqual(sandbox.run().status, 0);
  } finally { rmSync(sandbox.dir, { recursive: true, force: true }); }
});

/** The production schema-3 record that maps to `manifest` (the inverse of the importer's mapping). */
const productionRecord = (m: Record<string, any>) => ({ schemaVersion: 3, mode: "production", activated: true, releaseId: m.releaseId, chainId: m.chainId,
  startBlock: m.startBlock, bidRules: m.bidRules, roles: { curve: m.curve, registry: m.registry, quoteToken: m.quoteToken,
    controller: { address: m.auctionController, runtimeCodeHash: m.auctionBindings.controllerRuntimeCodeHash }, termsRegistry: m.termsRegistry,
    bidRouter: m.auctionBindings.bidRouter, adapter: m.auctionBindings.adapter, bidHook: m.auctionBindings.bidHook, exposureHelper: m.auctionBindings.exposureHelper } });
test("the importer maps a Gen8 record to the published manifest byte for byte and a Gen9 record with the same mapping", () => {
  const gen8 = gen8File(), gen9 = gen9Fixture() as Record<string, any>;
  const mapped8 = scripts.mapProductionManifest(scripts.manifestFor("gen8"), productionRecord(gen8));
  assert.equal(JSON.stringify(mapped8, null, 2) + "\n", read("deployments/elysium-testnet-gen8.json"));
  const mapped9 = scripts.mapProductionManifest(scripts.manifestFor("gen9"), productionRecord(gen9));
  assert.equal(mapped9.generation, "gen9"); assert.deepEqual(mapped9.quoteToken, mapped8.quoteToken);
  assert.deepEqual(Object.keys(mapped9), Object.keys(mapped8));
  const { note: _note, ...rest } = gen9;
  assert.deepEqual(mapped9, { ...rest, status: "live" });
  // A record is only the generation its slot names: the Gen8 record cannot become Gen9, nor the reverse.
  assert.throws(() => scripts.mapProductionManifest(scripts.manifestFor("gen9"), productionRecord(gen8)), /releaseId must start with elysium-auctions-gen9-/);
  assert.throws(() => scripts.mapProductionManifest(scripts.manifestFor("gen8"), productionRecord(gen9)), /releaseId must start with elysium-auctions-gen8-/);
  assert.throws(() => scripts.mapProductionManifest(scripts.manifestFor("gen9"), { ...productionRecord(gen9), activated: false }));
});
test("the importer refuses half a Gen9 request before reading or writing anything", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/import-live-manifests.mjs", ...args], { cwd: root, encoding: "utf8" });
  for (const half of ["--gen9-record=gen9/record.json", `--gen9-sha256=${"ab".repeat(32)}`]) {
    const result = run("missing-records", "missing-app", half);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /--gen9-record and --gen9-sha256 are supplied together/);
  }
  assert.match(run().stderr, /Supply the deployment records directory/);
});
