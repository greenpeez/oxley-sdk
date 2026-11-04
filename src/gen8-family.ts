/**
 * The Gen8 family: generations that run one contract stack (quote-only curve, accepted-bid router, adapter, Dynamic Bids hook,
 * exposure helper, terms registry) and therefore share every code path. Gen9 redeploys that stack unchanged except for the
 * launch controller, which gains a floor cap. Code that used to ask "is this Gen8?" asks this table instead of comparing an id
 * literal, so adding a member is one entry here. Each member keeps its own identity: a distinct `DeploymentGeneration` id, release
 * ID prefix and manifest file. The `gen8-*` source files hold the family's shared code; they are not specific to the Gen8 release.
 */
export const GEN8_FAMILY_IDS = ["gen8", "gen9"] as const;
export type Gen8FamilyId = (typeof GEN8_FAMILY_IDS)[number];

/** Gen9's launch controller reverts `FloorPriceAboveMaximum` above this floor, in the controller's `floorPriceWad` units. */
export const GEN9_MAX_FLOOR_PRICE_WAD = 10n ** 21n;

export interface Gen8FamilyMember {
  readonly id: Gen8FamilyId;
  /** Display name for messages. */
  readonly label: string;
  /** Release IDs of this generation start with this prefix (checked on the bundled manifests; caller-supplied ones may use any name). */
  readonly releaseIdPrefix: string;
  /** Reviewed testnet manifest, relative to the package root. Gen9's file exists only once its live deployment has been reviewed. */
  readonly manifestFile: string;
  /** The launch controller's floor cap, read back as `MAX_FLOOR_PRICE_WAD()`. Absent: the controller has no cap (Gen8). */
  readonly maxFloorPriceWad?: bigint;
}
export const GEN8_FAMILY: Readonly<Record<Gen8FamilyId, Gen8FamilyMember>> = Object.freeze({
  gen8: Object.freeze({ id: "gen8", label: "Gen8", releaseIdPrefix: "elysium-auctions-gen8-", manifestFile: "deployments/elysium-testnet-gen8.json" }),
  gen9: Object.freeze({ id: "gen9", label: "Gen9", releaseIdPrefix: "elysium-auctions-gen9-", manifestFile: "deployments/elysium-testnet-gen9.json",
    maxFloorPriceWad: GEN9_MAX_FLOOR_PRICE_WAD }),
});

/** True for every generation that shares the Gen8 contract stack (Gen8 itself and its redeployments). */
export const isGen8Family = (generation: unknown): generation is Gen8FamilyId =>
  typeof generation === "string" && Object.hasOwn(GEN8_FAMILY, generation);
export const gen8FamilyMember = (generation: unknown): Gen8FamilyMember | undefined =>
  isGen8Family(generation) ? GEN8_FAMILY[generation] : undefined;
export const GEN8_FAMILY_LABELS: readonly string[] = GEN8_FAMILY_IDS.map(id => GEN8_FAMILY[id].label);
/** The members' display names as prose for error messages, e.g. "Gen8 or Gen9". */
export const GEN8_FAMILY_NAMES = new Intl.ListFormat("en", { type: "disjunction" }).format(GEN8_FAMILY_LABELS);
