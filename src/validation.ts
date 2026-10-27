import { isAddress, maxUint256, zeroAddress, type Address, type Hex } from "viem";
import type { Deployment, DeploymentGeneration } from "./types.js";

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
function deploymentMetadata(d: Deployment): void {
  check(d.generation === undefined || d.generation === "flat-fee" || d.generation === "gen2",
    "INVALID_GENERATION", "generation must be omitted, \"flat-fee\" or \"gen2\"");
  for (const text of [d.status, d.note]) check(text === undefined || (typeof text === "string" && text.length > 0),
    "INVALID_DEPLOYMENT", "status and note must be non-empty strings when present");
}
function deploymentHeader(input: unknown): Deployment {
  check(!!input && typeof input === "object", "INVALID_DEPLOYMENT", "Deployment manifest required");
  const d = input as Deployment;
  check(d.schemaVersion === 1 && typeof d.releaseId === "string" && d.releaseId.length > 0,
    "INVALID_DEPLOYMENT", "Unsupported deployment schema or empty release ID");
  check(Number.isSafeInteger(d.chainId) && d.chainId > 0, "INVALID_CHAIN", "A positive chain ID is required");
  check(d.network === "testnet" || d.network === "mainnet", "INVALID_NETWORK", "Explicit network required");
  check(typeof d.startBlock === "string" && /^(0|[1-9][0-9]*)$/.test(d.startBlock),
    "INVALID_START_BLOCK", "startBlock must be a decimal block number");
  deploymentMetadata(d);
  return d;
}
/** Flat-fee unless the manifest explicitly declares another generation. */
export const deploymentGeneration = (d: Pick<Deployment, "generation">): DeploymentGeneration => d.generation ?? "flat-fee";
export function parseDeployment(input: unknown): Deployment {
  const d = deploymentHeader(input);
  for (const pin of [d.curve, d.registry, d.quoteToken]) {
    check(!!pin && typeof pin === "object", "INVALID_DEPLOYMENT", "Missing contract pin");
    address(pin.address); hash(pin.runtimeCodeHash);
  }
  address(d.auctionController);
  check(d.quoteToken.decimals === 6 && d.quoteToken.symbol === (d.network === "mainnet" ? "USDC" : "Oxy-USDC"),
    "INVALID_QUOTE_ASSET", "Mainnet requires USDC; testnet requires Oxy-USDC, both with six decimals");
  check(d.network !== "mainnet" || (d.chainId !== 99801 && !sameAddress(d.quoteToken.address,
    "0xa4ce6e6c719f7fb524230c367948039b078683e4")), "TESTNET_ON_MAINNET", "Testnet bindings cannot be used on mainnet");
  check(new Set([d.curve.address, d.registry.address, d.quoteToken.address].map(a => a.toLowerCase())).size === 3,
    "INVALID_DEPLOYMENT", "Curve, registry and quote token must be distinct");
  return Object.freeze({ ...d, curve: Object.freeze({ ...d.curve }), registry: Object.freeze({ ...d.registry }),
    quoteToken: Object.freeze({ ...d.quoteToken }) });
}
