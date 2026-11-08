import { isAddress, maxUint256, zeroAddress, type Address, type Hex } from "viem";

export class OxleyError extends Error {
  /** `details` carries structured values for UIs (for example an allowance or opening time). */
  constructor(readonly code: string, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message); this.name = "OxleyError";
  }
}
export function check(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new OxleyError(code, message);
}
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export function address(value: unknown): asserts value is Address {
  check(typeof value === "string" && isAddress(value, { strict: false }) && !sameAddress(value, zeroAddress),
    "INVALID_ADDRESS", "Expected a nonzero EVM address");
}
export function hash(value: unknown): asserts value is Hex {
  check(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n,
    "INVALID_HASH", "Expected a nonzero bytes32 value");
}
export function uint(value: unknown, positive = true): asserts value is bigint {
  check(typeof value === "bigint" && value >= (positive ? 1n : 0n) && value <= maxUint256,
    "INVALID_AMOUNT", "Amounts must be bigint uint256 base units");
}
