/**
 * The Gen8 family: generations that run one contract stack (quote-only curve, accepted-bid router, adapter, Dynamic Bids hook,
 * exposure helper, terms registry) and therefore share every code path. Gen9 redeploys that stack unchanged except for the
 * launch controller, which gains a floor cap. Gen10 redeploys Gen9's stack unchanged except for the launch controller's net
 * minimum raise ($30,000 instead of $50,000, a constructor-only literal), so its runtime ABI is Gen9's; it reuses Gen9's terms
 * registry. Code that used to ask "is this Gen8?" asks this table instead of comparing an id literal, so adding a member is one
 * entry here. Each member keeps its own identity: a distinct `DeploymentGeneration` id, release ID prefix and manifest file. The
 * `gen8-*` source files hold the family's shared code; they are not specific to the Gen8 release.
 */
export const GEN8_FAMILY_IDS = ["gen8", "gen9", "gen10"] as const;
export type Gen8FamilyId = (typeof GEN8_FAMILY_IDS)[number];

/** The launch controller's floor cap (Gen9 and Gen10): it reverts `FloorPriceAboveMaximum` above this floor, in the controller's `floorPriceWad` units. */
export const GEN9_MAX_FLOOR_PRICE_WAD = 10n ** 21n;
/** Net minimum raise of Gen8 and Gen9, in USDC base units (6 decimals): $50,000. */
export const GEN8_MINIMUM_NET_RAISE = 50_000_000_000n;
/** Net minimum raise of Gen10, in USDC base units (6 decimals): $30,000 (owner decision 2026-11-06). */
export const GEN10_MINIMUM_NET_RAISE = 30_000_000_000n;
/** The controller grosses the net minimum up for its 1% platform fee: `minimumGrossRaise() = mulDiv(net, 10_000, 9_900)`, rounded down. */
const PLATFORM_FEE_BPS = 100n, BPS = 10_000n;

export interface Gen8FamilyMember {
  readonly id: Gen8FamilyId;
  /** Display name for messages. */
  readonly label: string;
  /** Release IDs of this generation start with this prefix (checked on the bundled manifests; caller-supplied ones may use any name). */
  readonly releaseIdPrefix: string;
  /** Reviewed testnet manifest, relative to the package root. Gen9's file is not part of the bundle. */
  readonly manifestFile: string;
  /** The launch controller's floor cap, read back as `MAX_FLOOR_PRICE_WAD()`. Absent: the controller has no cap (Gen8). */
  readonly maxFloorPriceWad?: bigint;
  /** The launch controller's net minimum raise, read back as `minimumRaise()`, in USDC base units: the constructor argument its deployment passed. */
  readonly minimumNetRaise: bigint;
}
export const GEN8_FAMILY: Readonly<Record<Gen8FamilyId, Gen8FamilyMember>> = Object.freeze({
  gen8: Object.freeze({ id: "gen8", label: "Gen8", releaseIdPrefix: "elysium-auctions-gen8-", manifestFile: "deployments/elysium-testnet-gen8.json",
    minimumNetRaise: GEN8_MINIMUM_NET_RAISE }),
  gen9: Object.freeze({ id: "gen9", label: "Gen9", releaseIdPrefix: "elysium-auctions-gen9-", manifestFile: "deployments/elysium-testnet-gen9.json",
    maxFloorPriceWad: GEN9_MAX_FLOOR_PRICE_WAD, minimumNetRaise: GEN8_MINIMUM_NET_RAISE }),
  gen10: Object.freeze({ id: "gen10", label: "Gen10", releaseIdPrefix: "elysium-auctions-gen10-", manifestFile: "deployments/elysium-testnet-gen10.json",
    maxFloorPriceWad: GEN9_MAX_FLOOR_PRICE_WAD, minimumNetRaise: GEN10_MINIMUM_NET_RAISE }),
});

/** True for every generation that shares the Gen8 contract stack (Gen8 itself and its redeployments). */
export const isGen8Family = (generation: unknown): generation is Gen8FamilyId =>
  typeof generation === "string" && Object.hasOwn(GEN8_FAMILY, generation);
export const gen8FamilyMember = (generation: unknown): Gen8FamilyMember | undefined =>
  isGen8Family(generation) ? GEN8_FAMILY[generation] : undefined;
/** The member's net minimum raise in USDC base units (Gen8 and Gen9 50,000e6, Gen10 30,000e6). */
export const gen8MinimumNetRaise = (generation: Gen8FamilyId): bigint => GEN8_FAMILY[generation].minimumNetRaise;
/** The controller's `minimumGrossRaise()`: the net minimum grossed up for the 1% platform fee, rounded down (Gen8 and Gen9 50,505,050,505; Gen10 30,303,030,303). */
export const gen8MinimumGrossRaise = (generation: Gen8FamilyId): bigint => GEN8_FAMILY[generation].minimumNetRaise * BPS / (BPS - PLATFORM_FEE_BPS);
export const GEN8_FAMILY_LABELS: readonly string[] = GEN8_FAMILY_IDS.map(id => GEN8_FAMILY[id].label);
/** The members' display names as prose for error messages, e.g. "Gen8, Gen9, or Gen10". */
export const GEN8_FAMILY_NAMES = new Intl.ListFormat("en", { type: "disjunction" }).format(GEN8_FAMILY_LABELS);
