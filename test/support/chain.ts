import { keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import type { RpcClient } from "../../src/types.js";
import { BID_RULES } from "../../src/bid-rules.js";
import { scripts } from "./manifests.js";

export const addr = (n: number) => toHex(n, { size: 20 }) as Address;
export const id32 = (n: number | bigint) => toHex(n, { size: 32 });
export const blockHash = id32(456);
export const runtime = "0x60006000" as Hex;
export const pin = (n: number) => ({ address: addr(n), runtimeCodeHash: keccak256(runtime) });
export const full = (name: string) => JSON.parse(readFileSync(new URL(`../../abis/${name}.json`, import.meta.url), "utf8")) as Abi;
export const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** The synthetic deployment's addresses: curve 21, registry 22, quote token 3, controller 24, terms registry 25, router 26, adapter 27, hook 28, exposure helper 29, creator account factory 40, entry controller 41, bond escrow 42. */
export const BASE = 20;
/** Synthetic manifest with the shape of the reviewed one; every pin carries the RPC double's runtime hash. */
export function manifest(extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1 as const, releaseId: "test-deployment", status: "live", chainId: 31337, network: "testnet" as const, startBlock: "1",
    curve: pin(BASE + 1), registry: pin(BASE + 2), quoteToken: { ...pin(3), decimals: 6 as const, symbol: "Oxy-USDC" as const }, auctionController: addr(BASE + 4),
    termsRegistry: pin(BASE + 5),
    auctionBindings: { controllerRuntimeCodeHash: keccak256(runtime), bidRouter: pin(BASE + 6), adapter: pin(BASE + 7), bidHook: pin(BASE + 8), exposureHelper: pin(BASE + 9) },
    launchBindings: { creatorAccountFactory: pin(40), entryController: pin(41), bondEscrow: pin(42), launchFeeBaseUnits: "1500000", deployerBondWei: "500000000000000000" },
    bidRules: { ...BID_RULES }, ...extra };
}
/**
 * The owner's live deployment record (schema 3), byte for byte, and the SDK manifest the importer maps from
 * it. The two agree with the bundled `deployments/elysium-testnet.json` (test/deployment.test.ts); behaviour tests use this one, so a test never depends on the
 * bundle it also checks.
 */
export const productionRecord = () => JSON.parse(read("test/fixtures/production-record.json")) as Record<string, any>;
export const recordManifest = () => scripts.mapProductionManifest(lowerAddresses(productionRecord())) as unknown as ReturnType<typeof manifest>;
/** The importer lower-cases every address before mapping a record. */
export const lowerAddresses = (value: unknown) => JSON.parse(JSON.stringify(value), (_, item) => typeof item === "string" && /^0x[0-9a-fA-F]{40}$/.test(item) ? item.toLowerCase() : item);
/**
 * A manifest the offline RPC double can verify: every runtime code hash is the double's, and the chain ID and start block are its own.
 * Addresses, release and bindings are untouched.
 */
export const mockVerifiable = <T>(deployment: T): T => JSON.parse(JSON.stringify(deployment), (key, value: unknown) => {
  if (key === "runtimeCodeHash" || key === "controllerRuntimeCodeHash") return keccak256(runtime);
  return key === "chainId" ? 31337 : key === "startBlock" ? "1" : value;
}) as T;

export interface ReadCall { address: Address; functionName: string; args: readonly unknown[]; blockNumber: bigint }
export interface MockState {
  chainId: number; timestamp: bigint; reorg: boolean; codes: Map<string, Hex>; calls: ReadCall[]; simulations: { to: Address; data: Hex; account?: Address }[];
}
/** A viem-shaped read-only RPC double; `read` answers contract views, everything else is generic. */
export function mockRpc(read: (call: ReadCall, state: MockState) => unknown,
  options: { callResult?: (call: { to: Address; data: Hex }) => Hex | undefined; onCall?: (call: { to: Address; data: Hex; account?: Address }) => void;
    logs?: () => unknown[]; onLogs?: (request: unknown) => void; gas?: bigint } = {}) {
  const state: MockState = { chainId: 31337, timestamp: 1000n, reorg: false, codes: new Map(), calls: [], simulations: [] };
  const rpc = {
    getChainId: async () => state.chainId,
    getBlock: async (p: { blockNumber?: bigint }) => ({ number: p.blockNumber ?? 100n,
      hash: state.reorg && p.blockNumber !== undefined ? id32(999) : blockHash, timestamp: state.timestamp }),
    getCode: async (p: { address: Address }) => state.codes.get(p.address.toLowerCase()) ?? runtime,
    getLogs: async (p: unknown) => { options.onLogs?.(p); return options.logs?.() ?? []; },
    call: async (p: { to: Address; data: Hex; account?: Address }) => {
      state.simulations.push(p);
      options.onCall?.(p);
      return { data: options.callResult?.(p) ?? "0x" as Hex };
    },
    estimateGas: async () => options.gas ?? 200_000n,
    readContract: async (p: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber: bigint }) => {
      assertBlock(p.blockNumber);
      const call = { address: p.address, functionName: p.functionName, args: p.args ?? [], blockNumber: p.blockNumber };
      state.calls.push(call);
      return read(call, state);
    },
  } as unknown as RpcClient;
  return { rpc, state };
}
function assertBlock(blockNumber: bigint) {
  if (blockNumber !== 100n) throw new Error(`Unexpected block ${blockNumber}`);
}
export const failure = (message: string) => { throw new Error(message); };
