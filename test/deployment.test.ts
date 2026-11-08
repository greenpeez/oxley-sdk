import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FLOOR_PRICE_WAD, MINIMUM_GROSS_RAISE, MINIMUM_NET_RAISE, OxleyError, createOxleyClient, parseDeployment, testnetDeployment } from "../src/index.js";
import { createOxleyAuctionClient } from "../src/auctions.js";
import { createOxleyLaunchClient, parseLaunchDeployment } from "../src/launch.js";
import { BID_RULES } from "../src/auctions.js";
import { deploymentAddresses } from "../src/deployment-addresses.js";
import { addr, id32, lowerAddresses, manifest, mockVerifiable, pin, productionRecord, read, recordManifest } from "./support/chain.js";
import { createWorld } from "./support/world.js";
import { createAuctionWorld, dealId, NET_RAISE_50K, owner, type AuctionWorld } from "./support/auction.js";
import { scripts } from "./support/manifests.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const root = new URL("../", import.meta.url);
/** The live terms registry the reviewed deployment names; the mapped record must agree. */
const TERMS_REGISTRY = { address: "0x94c8c7203e2a01e37f104fa6cbe00382642c084d", runtimeCodeHash: "0x2aebc67f8fb67759321d1367cf8306bac96b66527b719f2598976994a87f052d" };

test("the bundled manifest is the live record mapped to the SDK shape: pinned by hash, equal to the embedded export, twelve distinct contracts", () => {
  const record = productionRecord(), fixture = recordManifest(), parsed = parseDeployment(fixture);
  // The record is the owner's file byte for byte, and the evidence file names the same hash for it.
  const recordSha = createHash("sha256").update(read("test/fixtures/production-record.json")).digest("hex");
  const evidence = JSON.parse(read("docs/live-artifacts.json")).deployments.find((item: { file: string }) => item.file === "deployments/elysium-testnet.json");
  assert.equal(recordSha, "dfbbba541ecc9049b371fa6fafb0f4bb29c6ccc6ae081cadad2de4fe408d9e8f"); assert.equal(evidence.sourceSha256, recordSha);
  assert.deepEqual([evidence.sourcePath, evidence.schemaVersion], ["gen10-live-20261106/gen10-deployment.json", 3]);
  // The bundle is exactly the importer's mapping of that record.
  assert.equal(JSON.stringify(fixture, null, 2) + "\n", read("deployments/elysium-testnet.json")); assert.deepEqual(testnetDeployment, fixture);
  assert.doesNotThrow(() => scripts.validateManifest(fixture));
  assert.deepEqual([record.mode, record.activated, record.schemaVersion], ["production", true, 3]);
  assert.equal(record.releaseId, `elysium-auctions-gen10-${record.planSha256.slice(0, 16)}`);
  // Identity and live pins.
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.termsRegistry) && Object.isFrozen(parsed.auctionBindings) && Object.isFrozen(parsed.bidRules));
  assert.deepEqual([parsed.releaseId, parsed.status, parsed.chainId, parsed.network, parsed.startBlock],
    ["elysium-auctions-gen10-1fa4ef2a98fd14ed", "live", 99801, "testnet", "25237151"]);
  assert.deepEqual([parsed.curve.address, parsed.registry.address, parsed.auctionController],
    ["0x68926b5e1b479c1ba32fe8e87699dfe5cfe7bd91", "0x1e59df61e52f494492cf38ca6ae49a2eba259e13", "0xff729e724c54045d04846cde960c3c5ad5e892fd"]);
  assert.equal(deploymentAddresses(fixture).length, 12); assert.deepEqual(fixture.bidRules, BID_RULES);
  // The launch bindings are the record's creator account factory, entry controller and bond escrow, with the launch fee (1.5 USDC) and the bond (0.5 HYPE).
  assert.deepEqual(fixture.launchBindings, { creatorAccountFactory: { address: "0x343ce625f9930648ccebe503bd274606b376d98c", runtimeCodeHash: record.roles.creatorAccountFactory.runtimeCodeHash },
    entryController: { address: "0x52f5728513ce57184713b109e0119f5b6455f47b", runtimeCodeHash: record.roles.entryController.runtimeCodeHash },
    bondEscrow: { address: "0x70032f2faee1a6d25cf191b513f0dc9adf8928cb", runtimeCodeHash: record.roles.bondEscrow.runtimeCodeHash }, launchFeeBaseUnits: "1500000", deployerBondWei: "500000000000000000" });
  assert.ok(Object.isFrozen(parsed.launchBindings) && Object.isFrozen(parsed.launchBindings!.creatorAccountFactory));
  assert.deepEqual(fixture.termsRegistry, TERMS_REGISTRY);
  assert.deepEqual(record.roles.termsRegistry, { address: TERMS_REGISTRY.address, runtimeCodeHash: TERMS_REGISTRY.runtimeCodeHash });
  // The embedded module is generated: it must not drift from the JSON file.
  assert.doesNotThrow(() => execFileSync(process.execPath, ["scripts/embed-deployments.mjs", "--check"], { stdio: "pipe" }));
});
test("the importer maps the record, refuses another release, an inactive record and a rehearsal, and drops every role the SDK does not read", () => {
  const record = lowerAddresses(productionRecord()), mapped = scripts.mapProductionManifest(record);
  assert.deepEqual(Object.keys(mapped), ["schemaVersion", "releaseId", "status", "chainId", "network", "startBlock", "curve", "registry", "quoteToken",
    "auctionController", "termsRegistry", "auctionBindings", "launchBindings", "bidRules"]);
  assert.deepEqual(mapped.quoteToken, { ...record.roles.quoteToken, symbol: "Oxy-USDC", decimals: 6 });
  assert.deepEqual(mapped.bidRules, record.bidRules);
  assert.deepEqual(mapped.launchBindings, { creatorAccountFactory: { address: record.roles.creatorAccountFactory.address, runtimeCodeHash: record.roles.creatorAccountFactory.runtimeCodeHash },
    entryController: { address: record.roles.entryController.address, runtimeCodeHash: record.roles.entryController.runtimeCodeHash },
    bondEscrow: { address: record.roles.bondEscrow.address, runtimeCodeHash: record.roles.bondEscrow.runtimeCodeHash }, ...scripts.LAUNCH_COSTS });
  assert.throws(() => scripts.mapProductionManifest({ ...record, activated: false }));
  assert.throws(() => scripts.mapProductionManifest({ ...record, mode: "rehearsal" }));
  assert.throws(() => scripts.mapProductionManifest({ ...record, schemaVersion: 2 }));
  assert.throws(() => scripts.mapProductionManifest({ ...record, releaseId: "elysium-auctions-gen9-1fa4ef2a98fd14ed" }), /releaseId must start with elysium-auctions-gen10-/);
  assert.throws(() => scripts.validateManifest({ ...mapped, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => scripts.validateManifest({ ...mapped, releaseId: "elysium-auctions-flat-fee-1" }), /releaseId must start with/);
});
test("a manifest pins every contract, the exact bid rules and distinct addresses; placeholders and testnet bindings on mainnet are refused", () => {
  const good = manifest(), bindings = good.auctionBindings;
  const parsed = parseDeployment(good);
  assert.ok(Object.isFrozen(parsed.auctionBindings.bidHook) && Object.isFrozen(parsed.bidRules));
  for (const role of ["bidRouter", "adapter", "bidHook", "exposureHelper"] as const) {
    const { [role]: _removed, ...rest } = bindings;
    assert.throws(() => parseDeployment({ ...good, auctionBindings: rest }), code("AUCTION_BINDINGS_REQUIRED"), role);
  }
  const { termsRegistry: _terms, ...withoutTerms } = good;
  assert.throws(() => parseDeployment(withoutTerms), code("AUCTION_BINDINGS_REQUIRED"));
  assert.throws(() => parseDeployment({ ...good, auctionBindings: undefined }), code("AUCTION_BINDINGS_REQUIRED"));
  assert.throws(() => parseDeployment({ ...good, auctionBindings: { ...bindings, controllerRuntimeCodeHash: "0x00" } }), code("INVALID_HASH"));
  assert.throws(() => parseDeployment({ ...good, bidRules: { ...BID_RULES, minBid: "10000000" } }), code("INVALID_BID_RULES"));
  assert.throws(() => parseDeployment({ ...good, bidRules: { ...BID_RULES, extra: 1 } }), code("INVALID_BID_RULES"));
  assert.throws(() => parseDeployment({ ...good, bidRules: undefined }), code("INVALID_BID_RULES"));
  // Every pin must be a distinct contract: a hook that is the adapter, a terms registry that is the curve, a controller that is the router.
  assert.throws(() => parseDeployment({ ...good, auctionBindings: { ...bindings, bidHook: bindings.adapter } }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseDeployment({ ...good, termsRegistry: good.curve }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseDeployment({ ...good, auctionController: bindings.bidRouter.address }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseDeployment({ ...good, termsRegistry: { ...good.termsRegistry, address: addr(0) } }), code("INVALID_ADDRESS"));
  assert.throws(() => parseDeployment({ ...good, status: "" }), code("INVALID_DEPLOYMENT"));
  assert.throws(() => parseDeployment(JSON.parse(read("deployments/mainnet.template.json"))));
  assert.throws(() => parseDeployment({ ...good, network: "mainnet", chainId: 99801, quoteToken: { ...good.quoteToken, symbol: "USDC" } }), code("TESTNET_ON_MAINNET"));
  assert.equal(parseDeployment({ ...good, network: "mainnet", quoteToken: { ...good.quoteToken, symbol: "USDC" } }).network, "mainnet");
});
test("the mainnet template has the bundled manifest's fields, with placeholders for deployment values and the exact bid rules", () => {
  const template = JSON.parse(read("deployments/mainnet.template.json")), bundled = JSON.parse(read("deployments/elysium-testnet.json"));
  const shape = (value: unknown): unknown => Array.isArray(value) || value === null || typeof value !== "object" ? null
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]));
  assert.deepEqual(shape(template), shape(bundled)); assert.equal(template.network, "mainnet"); assert.equal(template.quoteToken.symbol, "USDC");
  assert.deepEqual(template.bidRules, BID_RULES);
  const placeholders = JSON.stringify(template).match(/null|REPLACE_WITH/g) ?? [];
  assert.ok(placeholders.length >= 26, "deployment values are placeholders");
  // The bond is a constant of the contracts and is filled in; the launch fee is a deployment input and is a placeholder.
  assert.deepEqual([template.launchBindings.deployerBondWei, template.launchBindings.launchFeeBaseUnits], ["500000000000000000", null]);
});

const withNetRaise = (net: bigint, cap: bigint | null = MAX_FLOOR_PRICE_WAD) => createAuctionWorld(mockVerifiable(recordManifest()), cap, net);
test("the net minimum raise is $30,000 and the gross minimum is the controller's net * 10,000 / 9,900 rounded down", () => {
  assert.deepEqual([MINIMUM_NET_RAISE, MINIMUM_GROSS_RAISE, MAX_FLOOR_PRICE_WAD], [30_000_000_000n, 30_303_030_303n, 10n ** 21n]);
  assert.ok(MINIMUM_GROSS_RAISE * 9_900n <= MINIMUM_NET_RAISE * 10_000n && (MINIMUM_GROSS_RAISE + 1n) * 9_900n > MINIMUM_NET_RAISE * 10_000n);
});
test("verifying the deployment reads the controller's floor cap and its $30,000 minimum raise at one block", async () => {
  const chain = withNetRaise(MINIMUM_NET_RAISE);
  assert.equal((await chain.client().verifyDeployment()).blockNumber, 100n);
  const reads = (name: string) => chain.world.reads.filter(call => call.functionName === name).map(call => [call.address, call.blockNumber]);
  assert.deepEqual(reads("MAX_FLOOR_PRICE_WAD"), [[chain.roles.controller, 100n]]);
  assert.deepEqual(reads("minimumRaise"), [[chain.roles.controller, 100n]]); assert.deepEqual(reads("minimumGrossRaise"), [[chain.roles.controller, 100n]]);
  assert.equal((await chain.client().getDynamicBidLimits({ dealId, owner })).blockNumber, 100n);
});
test("a controller with another minimum raise fails closed, so a $50,000 stack cannot pass as this deployment", async () => {
  await withNetRaise(MINIMUM_NET_RAISE).client().verifyDeployment();
  await assert.rejects(withNetRaise(NET_RAISE_50K).client().verifyDeployment(), (error: unknown) =>
    code("AUCTION_BINDING_MISMATCH")(error) && /controller's minimum raise differs from the 30,000 USDC/.test((error as Error).message));
  for (const net of [MINIMUM_NET_RAISE - 1n, MINIMUM_NET_RAISE + 1n, 29_700_000_000n, 40_000_000_000n, 0n]) {
    await assert.rejects(withNetRaise(net).client().verifyDeployment(), code("AUCTION_BINDING_MISMATCH"), String(net));
  }
  // The gross view is checked as well: the net value alone does not pass a controller whose gross figure disagrees.
  const liar = withNetRaise(MINIMUM_NET_RAISE), original = liar.rpc.readContract.bind(liar.rpc);
  (liar.rpc as { readContract: unknown }).readContract = async (call: { functionName: string }) => call.functionName === "minimumGrossRaise" ? MINIMUM_GROSS_RAISE - 1n : original(call as never);
  await assert.rejects(liar.client().verifyDeployment(), code("AUCTION_BINDING_MISMATCH"));
});
test("a controller that is uncapped or capped differently fails closed, and so does a changed hook, helper or terms registry", async () => {
  for (const cap of [MAX_FLOOR_PRICE_WAD - 1n, MAX_FLOOR_PRICE_WAD * 2n, 0n]) {
    await assert.rejects(withNetRaise(MINIMUM_NET_RAISE, cap).client().verifyDeployment(), code("AUCTION_BINDING_MISMATCH"), String(cap));
  }
  await assert.rejects(withNetRaise(MINIMUM_NET_RAISE, null).client().verifyDeployment(), /MAX_FLOOR_PRICE_WAD/); // no getter: an uncapped controller
  const mutate: [string, (c: AuctionWorld) => void][] = [
    ["hook terms", c => { c.world.hookTerms = addr(99); }], ["hook rules", c => { c.world.hookRulesMinimum = 10_000_000n; }],
    ["exposure code", c => { c.state.codes.set(c.roles.exposure, "0x"); }], ["hook code", c => { c.state.codes.set(c.roles.hook, "0x"); }],
    ["terms code", c => { c.state.codes.set(c.roles.terms, "0x"); }],
  ];
  for (const [label, change] of mutate) {
    const chain = withNetRaise(MINIMUM_NET_RAISE); change(chain);
    await assert.rejects(chain.client().verifyDeployment(), (error: unknown) => error instanceof OxleyError && /MISMATCH/.test(error.code), label);
  }
});

/** A scratch copy of the embed script and the manifest it reads, so absent and mis-slotted manifests can be tried without touching the package. */
function embedSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "oxley-embed-"));
  for (const folder of ["scripts", "deployments", "src"]) mkdirSync(join(dir, folder));
  for (const file of ["scripts/embed-deployments.mjs", "scripts/deployment-manifests.mjs", "src/testnet-deployment.ts", "deployments/elysium-testnet.json"]) {
    copyFileSync(new URL(file, root), join(dir, file));
  }
  const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/embed-deployments.mjs", ...args], { cwd: dir, encoding: "utf8" });
  return { dir, run, put: (file: string, text: string) => writeFileSync(join(dir, file), text), generated: () => readFileSync(join(dir, "src/testnet-deployment.ts"), "utf8") };
}
test("embedding is exact, detects a stale module and refuses a missing manifest or another release's manifest", () => {
  const sandbox = embedSandbox();
  try {
    assert.equal(sandbox.run("--check").status, 0);
    assert.match(sandbox.generated(), /export const testnetDeployment = \{/);
    const manifest = JSON.parse(read("deployments/elysium-testnet.json"));
    sandbox.put("deployments/elysium-testnet.json", JSON.stringify({ ...manifest, startBlock: "25237152" }, null, 2) + "\n");
    const stale = sandbox.run("--check");
    assert.equal(stale.status, 1); assert.match(stale.stderr, /stale; run npm run embed/);
    assert.equal(sandbox.run().status, 0); assert.match(sandbox.generated(), /"startBlock": "25237152"/); assert.equal(sandbox.run("--check").status, 0);
    sandbox.put("deployments/elysium-testnet.json", JSON.stringify({ ...manifest, releaseId: "elysium-auctions-gen9-1fa4ef2a98fd14ed" }, null, 2) + "\n");
    assert.match(sandbox.run().stderr, /releaseId must start with elysium-auctions-gen10-/);
    rmSync(join(sandbox.dir, "deployments/elysium-testnet.json"));
    assert.notEqual(sandbox.run().status, 0);
  } finally { rmSync(sandbox.dir, { recursive: true, force: true }); }
});

test("launchBindings are optional outside the launch client: the manifest parses without them (nine distinct contracts) and with them (twelve), and only the launch client requires them", async () => {
  const good = manifest(), { launchBindings, ...without } = good;
  const parsed = parseDeployment(without);
  assert.equal("launchBindings" in parsed, false, "absent stays absent: no undefined key");
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.curve) && Object.isFrozen(parsed.auctionBindings.bidHook));
  assert.deepEqual(Object.keys(parseDeployment(good)).filter(key => !(key in parsed)), ["launchBindings"]);
  // The nine-contract rule when absent: the controller and the eight pins are all different.
  const nine: [string, Record<string, unknown>][] = [
    ["curve is the registry", { curve: without.registry }], ["controller is the curve", { auctionController: without.curve.address }],
    ["bid hook is the router", { auctionBindings: { ...without.auctionBindings, bidHook: without.auctionBindings.bidRouter } }],
    ["quote is the terms registry", { quoteToken: { ...without.quoteToken, ...without.termsRegistry } }],
  ];
  for (const [label, patch] of nine) assert.throws(() => parseDeployment({ ...without, ...patch }), code("INVALID_DEPLOYMENT"), label);
  // The twelve-contract rule when present: each launch pin differs from the nine and from the other two.
  for (const key of ["creatorAccountFactory", "entryController", "bondEscrow"] as const) {
    assert.throws(() => parseDeployment({ ...good, launchBindings: { ...launchBindings, [key]: { ...launchBindings[key], address: good.auctionController } } }), code("INVALID_DEPLOYMENT"), `${key} reuses the controller`);
    assert.throws(() => parseDeployment({ ...good, launchBindings: { ...launchBindings, [key]: good.auctionBindings.bidHook } }), code("INVALID_DEPLOYMENT"), `${key} reuses the hook`);
  }
  assert.throws(() => parseDeployment({ ...good, launchBindings: { ...launchBindings, entryController: launchBindings.bondEscrow } }), code("INVALID_DEPLOYMENT"));
  assert.doesNotThrow(() => parseDeployment({ ...good, launchBindings: { ...launchBindings, bondEscrow: pin(43) } }));
  // Present means validated, for every client: nothing partial, malformed or mistaken passes because the caller never meant to launch.
  for (const bad of [null, {}, [], "bindings", 7, { ...launchBindings, creatorAccountFactory: undefined }, { ...launchBindings, entryController: "0x1" }]) {
    assert.throws(() => parseDeployment({ ...without, launchBindings: bad }), code("LAUNCH_BINDINGS_REQUIRED"), JSON.stringify(bad));
  }
  assert.throws(() => parseDeployment({ ...without, launchBindings: { ...launchBindings, bondEscrow: { ...launchBindings.bondEscrow, runtimeCodeHash: id32(0) } } }), code("INVALID_HASH"));
  assert.throws(() => parseDeployment({ ...without, launchBindings: { ...launchBindings, bondEscrow: { ...launchBindings.bondEscrow, address: addr(0) } } }), code("INVALID_ADDRESS"));
  assert.throws(() => parseDeployment({ ...without, launchBindings: { ...launchBindings, deployerBondWei: "1" } }), code("INVALID_BOND"));
  assert.throws(() => parseDeployment({ ...without, launchBindings: { ...launchBindings, launchFeeBaseUnits: "0" } }), code("INVALID_LAUNCH_COST"));
  assert.throws(() => createOxleyClient({ publicClient: createWorld().rpc, deployment: { ...without, launchBindings: { ...launchBindings, deployerBondWei: "1" } } }), code("INVALID_BOND"));
  assert.throws(() => createOxleyAuctionClient({ publicClient: createWorld().rpc, deployment: { ...without, launchBindings: {} } }), code("LAUNCH_BINDINGS_REQUIRED"));
  // The trading and auction clients work on a manifest without bindings, verifying the same graph.
  assert.doesNotThrow(() => createOxleyClient({ publicClient: createWorld().rpc, deployment: without }));
  assert.equal((await createOxleyClient({ publicClient: createWorld().rpc, deployment: without }).verifyDeployment()).blockNumber, 100n);
  const world = createAuctionWorld(without as never);
  assert.equal((await world.client().verifyDeployment()).blockNumber, 100n);
  assert.equal((await createAuctionWorld(good).client().verifyDeployment()).blockNumber, 100n);
  // The launch client requires them, with the same code whether the key is absent or the manifest is parsed first.
  assert.throws(() => createOxleyLaunchClient({ publicClient: createWorld().rpc as never, deployment: without }), code("LAUNCH_BINDINGS_REQUIRED"));
  assert.throws(() => createOxleyLaunchClient({ publicClient: createWorld().rpc as never, deployment: parsed }), code("LAUNCH_BINDINGS_REQUIRED"));
  assert.throws(() => parseLaunchDeployment(without), code("LAUNCH_BINDINGS_REQUIRED"));
  assert.doesNotThrow(() => createOxleyLaunchClient({ publicClient: createWorld().rpc as never, deployment: good }));
  assert.equal(parseLaunchDeployment(good).launchBindings.deployerBondWei, "500000000000000000");
  // The bundled testnet manifest keeps them, so the launch client takes it as it is.
  assert.doesNotThrow(() => createOxleyLaunchClient({ publicClient: createWorld().rpc as never, deployment: testnetDeployment }));
  const { launchBindings: _bundled, ...bundledWithout } = testnetDeployment;
  assert.equal(parseDeployment(bundledWithout).chainId, 99801);
  assert.throws(() => createOxleyLaunchClient({ publicClient: createWorld().rpc as never, deployment: bundledWithout }), code("LAUNCH_BINDINGS_REQUIRED"));
});
