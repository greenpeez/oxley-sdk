import assert from "node:assert/strict";

// The bundled testnet manifests, oldest first: one table for embed-deployments, import-live-manifests and check-package. A Gen8-family
// entry (gen8, gen9, gen10) must agree with GEN8_FAMILY in src/gen8-family.ts; test/gen8-family.test.ts enforces that.
// `required: false` marks a manifest that may not exist yet (Gen9: its live manifest has not been added to the bundle). It is then
// reported as absent and left out of the bundle; it is never silently skipped and never invented.
// `family: true` marks a Gen8-family member. The newest present member is the current launch generation, as in the app, which launches
// on the newest enabled family member; the earlier members keep trading and claiming. `launchNote` is the member's one-line description.
export const MANIFESTS = [
  { exportName: "flatFeeTestnetDeployment", file: "deployments/elysium-testnet.json", releaseIdPrefix: "elysium-auctions-flat-fee-", required: true },
  { exportName: "gen3TestnetDeployment", file: "deployments/elysium-testnet-gen3.json", generation: "gen3", releaseIdPrefix: "elysium-auctions-gen3-", required: true },
  { exportName: "gen8TestnetDeployment", file: "deployments/elysium-testnet-gen8.json", generation: "gen8", releaseIdPrefix: "elysium-auctions-gen8-", required: true,
    family: true, label: "Gen8", launchNote: "the first Gen8-family stack" },
  { exportName: "gen9TestnetDeployment", file: "deployments/elysium-testnet-gen9.json", generation: "gen9", releaseIdPrefix: "elysium-auctions-gen9-", required: false,
    family: true, label: "Gen9", launchNote: "the Gen8 contracts plus a launch floor cap" },
  { exportName: "gen10TestnetDeployment", file: "deployments/elysium-testnet-gen10.json", generation: "gen10", releaseIdPrefix: "elysium-auctions-gen10-", required: true,
    family: true, label: "Gen10", launchNote: "the Gen9 contracts with a $30,000 net minimum raise" },
];
export const manifestFor = generation => {
  const entry = MANIFESTS.find(item => item.generation === generation);
  assert.ok(entry, `No bundled manifest for ${generation}`);
  return entry;
};

/** A manifest file must be the generation its slot names, with that generation's release-ID prefix: a Gen9 file in the Gen8 slot (or the reverse) is refused. */
export function validateManifest(entry, manifest) {
  assert.equal(manifest.schemaVersion, 1, `${entry.file}: schemaVersion must be 1`);
  assert.equal(manifest.generation, entry.generation, `${entry.file}: generation must be ${entry.generation ?? "absent (flat-fee)"}`);
  assert.ok(typeof manifest.releaseId === "string" && manifest.releaseId.startsWith(entry.releaseIdPrefix),
    `${entry.file}: releaseId must start with ${entry.releaseIdPrefix}`);
}

const pin = role => ({ address: role.address, runtimeCodeHash: role.runtimeCodeHash });
/**
 * The production schema-3 record (addresses already lower-cased) mapped to the SDK's deployment shape; only the roles the SDK reads are
 * pinned. Gen8, Gen9 and Gen10 share this mapping. The key order is the order of the published Gen8 manifest.
 */
export function mapProductionManifest(entry, production) {
  const roles = production.roles;
  assert.equal(production.schemaVersion, 3); assert.equal(production.mode, "production"); assert.equal(production.activated, true);
  const manifest = { schemaVersion: 1, releaseId: production.releaseId, generation: entry.generation, status: "live", chainId: production.chainId,
    network: "testnet", startBlock: production.startBlock, curve: pin(roles.curve), registry: pin(roles.registry),
    quoteToken: { ...pin(roles.quoteToken), symbol: "Oxy-USDC", decimals: 6 }, auctionController: roles.controller.address,
    termsRegistry: pin(roles.termsRegistry), auctionBindings: { controllerRuntimeCodeHash: roles.controller.runtimeCodeHash, bidRouter: pin(roles.bidRouter),
      adapter: pin(roles.adapter), bidHook: pin(roles.bidHook), exposureHelper: pin(roles.exposureHelper) }, bidRules: production.bidRules };
  validateManifest(entry, manifest);
  return manifest;
}
