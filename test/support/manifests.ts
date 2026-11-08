/** The release scripts' manifest slot and importer mapping (plain JavaScript, shared by embed-deployments, import-live-manifests and check-package), typed for the tests. */
export interface ManifestEntry { exportName: string; file: string; releaseIdPrefix: string }
interface ManifestsModule {
  MANIFEST: ManifestEntry;
  validateManifest(manifest: unknown, entry?: ManifestEntry): void;
  mapProductionManifest(production: unknown, entry?: ManifestEntry): Record<string, unknown>;
}
// A computed specifier keeps TypeScript from asking for declarations of the .mjs file.
export const scripts = await import(new URL("../../scripts/deployment-manifests.mjs", import.meta.url).href) as ManifestsModule;
