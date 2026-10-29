import { isDeepStrictEqual } from "node:util";
import type { Abi } from "viem";

/** Compiler ABI entry minus names and `internalType` (typed subsets use human-readable ABIs). */
export const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([k, v]) => !["name", "internalType"].includes(k) && !(["indexed", "anonymous"].includes(k) && v === false))
    .map(([k, v]) => [k, shape(v)]));
  return value;
};
export const matches = (entry: { type: string; name?: string }, abi: Abi) => abi.some(candidate => candidate.type === entry.type
  && "name" in candidate && candidate.name === entry.name && isDeepStrictEqual(shape(candidate), shape(entry)));
