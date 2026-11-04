/** The release scripts' manifest table (plain JavaScript, shared by embed-deployments, import-live-manifests and check-package), typed for the tests. */
export interface ManifestEntry { exportName: string; file: string; generation?: string; releaseIdPrefix: string; required: boolean }
interface ManifestsModule {
  MANIFESTS: ManifestEntry[];
  manifestFor(generation: string): ManifestEntry;
  validateManifest(entry: ManifestEntry, manifest: unknown): void;
  mapProductionManifest(entry: ManifestEntry, production: unknown): Record<string, unknown>;
}
// A computed specifier keeps TypeScript from asking for declarations of the .mjs file.
export const scripts = await import(new URL("../../scripts/deployment-manifests.mjs", import.meta.url).href) as ManifestsModule;
