import type { Address } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Every address a parsed manifest names (pins, controller, bindings, protocol roles), lower-cased and de-duplicated. */
export function deploymentAddresses(manifest: unknown): readonly Address[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (typeof value === "string" && ADDRESS.test(value)) found.add(value.toLowerCase());
    else if (value && typeof value === "object" && depth < 5) for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(manifest, 0);
  return [...found] as Address[];
}
