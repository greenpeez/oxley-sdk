import assert from "node:assert/strict";

// The one bundled testnet manifest: a single table for embed-deployments, import-live-manifests and check-package.
// A production record is accepted only if its release ID carries this prefix, so another release's record cannot be imported by mistake.
export const MANIFEST = { exportName: "testnetDeployment", file: "deployments/elysium-testnet.json", releaseIdPrefix: "elysium-auctions-gen10-" };

/** A manifest file must be the release its slot names: schema 1 and a release ID with the slot's prefix. */
export function validateManifest(manifest, entry = MANIFEST) {
  assert.equal(manifest.schemaVersion, 1, `${entry.file}: schemaVersion must be 1`);
  assert.ok(typeof manifest.releaseId === "string" && manifest.releaseId.startsWith(entry.releaseIdPrefix),
    `${entry.file}: releaseId must start with ${entry.releaseIdPrefix}`);
}

const pin = role => ({ address: role.address, runtimeCodeHash: role.runtimeCodeHash });
/**
 * The production schema-3 record (addresses already lower-cased) mapped to the SDK's deployment shape; only the roles the SDK reads are
 * pinned. The key order is the order of the bundled manifest.
 */
export function mapProductionManifest(production, entry = MANIFEST) {
  const roles = production.roles;
  assert.equal(production.schemaVersion, 3); assert.equal(production.mode, "production"); assert.equal(production.activated, true);
  const manifest = { schemaVersion: 1, releaseId: production.releaseId, status: "live", chainId: production.chainId,
    network: "testnet", startBlock: production.startBlock, curve: pin(roles.curve), registry: pin(roles.registry),
    quoteToken: { ...pin(roles.quoteToken), symbol: "Oxy-USDC", decimals: 6 }, auctionController: roles.controller.address,
    termsRegistry: pin(roles.termsRegistry), auctionBindings: { controllerRuntimeCodeHash: roles.controller.runtimeCodeHash, bidRouter: pin(roles.bidRouter),
      adapter: pin(roles.adapter), bidHook: pin(roles.bidHook), exposureHelper: pin(roles.exposureHelper) }, bidRules: production.bidRules };
  validateManifest(manifest, entry);
  return manifest;
}
