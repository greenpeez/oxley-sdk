import { keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import type { RpcClient } from "../../src/types.js";
import { scripts } from "./manifests.js";

export const addr = (n: number) => toHex(n, { size: 20 }) as Address;
export const id32 = (n: number | bigint) => toHex(n, { size: 32 });
export const blockHash = id32(456);
export const runtime = "0x60006000" as Hex;
export const pin = (n: number) => ({ address: addr(n), runtimeCodeHash: keccak256(runtime) });
export const full = (name: string) => JSON.parse(readFileSync(new URL(`../../abis/${name}.json`, import.meta.url), "utf8")) as Abi;
export const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

export type Generation = "flat-fee" | "gen3" | "gen8" | "gen9" | "gen10";
/** Gen8, Gen9 and Gen10 run one contract stack. Kept as its own literal list so the tests do not lean on the SDK's family helper. */
export const isQuoteOnly = (generation: Generation) => generation === "gen8" || generation === "gen9" || generation === "gen10";
/** Synthetic manifest: addresses `base+1..base+9`, the quote token (3) shared like the real graph. */
export function manifest(generation: Generation, base: number, extra: Record<string, unknown> = {}) {
  const terms = generation !== "flat-fee";
  return { schemaVersion: 1, releaseId: `test-${generation}`, chainId: 31337, network: "testnet", startBlock: "1",
    ...generation === "flat-fee" ? {} : { generation, status: "live" },
    curve: pin(base + 1), registry: pin(base + 2), quoteToken: { ...pin(3), decimals: 6, symbol: "Oxy-USDC" }, auctionController: addr(base + 4),
    ...terms ? { termsRegistry: pin(base + 5) } : {},
    auctionBindings: { controllerRuntimeCodeHash: keccak256(runtime), bidRouter: pin(base + 6), adapter: pin(base + 7),
      ...isQuoteOnly(generation) ? { bidHook: pin(base + 8), exposureHelper: pin(base + 9) } : {} },
    ...isQuoteOnly(generation) ? { bidRules: { version: "8", minBid: "20000000", tokenCap: "30000000000000000000000000", liveBids: 3,
      walletBids: 12, hookMaxBids: 0, capacityMaxBids: 0, maxPriceLevels: 1000 } } : {}, ...extra };
}
export const BASES: Record<Generation, number> = { "flat-fee": 0, gen3: 10, gen8: 20, gen9: 40, gen10: 60 };

/** The checked-in Gen9 fixture manifest: placeholder addresses and runtime hashes; its Oxy-USDC pin is Gen8's. */
export const gen9Fixture = () => JSON.parse(read("test/fixtures/elysium-testnet-gen9.fixture.json")) as ReturnType<typeof manifest>;
/**
 * The owner's live Gen10 deployment record (schema 3, `gen10-live-20261106/gen10-deployment.json`, release elysium-auctions-gen10-1fa4ef2a98fd14ed), byte for byte, and
 * the SDK manifest the importer maps from it. The two agree with the bundled `deployments/elysium-testnet-gen10.json` (test/gen10.test.ts); behaviour tests use this
 * one, so a test never depends on the bundle it also checks.
 */
export const gen10Record = () => JSON.parse(read("test/fixtures/gen10-production-record.json")) as Record<string, any>;
export const gen10Fixture = () => scripts.mapProductionManifest(scripts.manifestFor("gen10"), lowerAddresses(gen10Record())) as unknown as ReturnType<typeof manifest>;
/** The importer lower-cases every address before mapping a record. */
export const lowerAddresses = (value: unknown) => JSON.parse(JSON.stringify(value), (_, item) => typeof item === "string" && /^0x[0-9a-fA-F]{40}$/.test(item) ? item.toLowerCase() : item);
/**
 * A manifest the offline RPC double can verify: every runtime code hash is the double's, and the chain ID and start block are its own.
 * Addresses, generation, release and bindings are untouched.
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
    logs?: () => unknown[]; gas?: bigint } = {}) {
  const state: MockState = { chainId: 31337, timestamp: 1000n, reorg: false, codes: new Map(), calls: [], simulations: [] };
  const rpc = {
    getChainId: async () => state.chainId,
    getBlock: async (p: { blockNumber?: bigint }) => ({ number: p.blockNumber ?? 100n,
      hash: state.reorg && p.blockNumber !== undefined ? id32(999) : blockHash, timestamp: state.timestamp }),
    getCode: async (p: { address: Address }) => state.codes.get(p.address.toLowerCase()) ?? runtime,
    getLogs: async () => options.logs?.() ?? [],
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
