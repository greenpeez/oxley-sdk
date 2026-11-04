import { decodeFunctionData, encodeFunctionResult, maxUint256, type Address, type Hex } from "viem";
import { ccaCheckpointAbi, gen8BidHookAbi } from "../../src/gen8-abis.js";
import { createOxleyAuctionClient } from "../../src/auctions.js";
import { addr, id32, manifest, mockRpc, type ReadCall } from "./chain.js";

export const dealId = id32(0xd1), auction = addr(30), coin = addr(31), creator = addr(7), owner = addr(9);
/** The synthetic Gen8 graph's roles (`manifest("gen8", 20)`). A world built from another manifest has its own `roles`. */
export const [CONTROLLER, ROUTER, ADAPTER, HOOK, EXPOSURE, TERMS, REGISTRY, QUOTE] = [addr(24), addr(26), addr(27), addr(28), addr(29), addr(25), addr(22), addr(3)];
type AuctionManifest = ReturnType<typeof manifest>;
export interface Roles { controller: Address; router: Address; adapter: Address; hook: Address; exposure: Address; terms: Address; registry: Address; quote: Address }
/** The roles a world answers for, read from the manifest the client will be given. */
export function rolesOf(deployment: AuctionManifest): Roles {
  const bindings = deployment.auctionBindings as { bidRouter: { address: Address }; adapter: { address: Address }; bidHook?: { address: Address }; exposureHelper?: { address: Address } };
  return { controller: deployment.auctionController, router: bindings.bidRouter.address, adapter: bindings.adapter.address, hook: bindings.bidHook!.address,
    exposure: bindings.exposureHelper!.address, terms: deployment.termsRegistry!.address, registry: deployment.registry.address, quote: deployment.quoteToken.address };
}
export interface Checkpoint { clearingPrice: bigint; prev: bigint; next: bigint }
export interface StoredBid { id: bigint; owner: Address; maxPrice: bigint; startBlock: bigint; amountQ96: bigint; exitedBlock: bigint }

function newWorld(roles: Roles, floorCap: bigint | undefined) {
  return {
    roles, floorCap,
    block: 150n, start: 100n, end: 10_000n, floor: 1000n, tick: 100n, maxPrice: 1_000_000n, open: true, minimumRaiseMet: false,
    balance: 1_000_000_000n, allowance: 0n, termsAccepted: true, creatorExcluded: false,
    minimum: 50_505_050_505n, preview: { committed: 0n, ceiling: 5_050_505_051n, allowance: 5_050_505_051n },
    ids: [] as bigint[], bids: new Map<bigint, StoredBid>(), checkpoints: new Map<bigint, Checkpoint>([[10n, { clearingPrice: 100n, prev: 0n, next: 20n }],
      [20n, { clearingPrice: 150n, prev: 10n, next: 30n }], [30n, { clearingPrice: 200n, prev: 20n, next: 0n }]]),
    last: 30n, logs: [] as { args: { blockNumber: bigint; clearingPriceQ96: bigint; cumulativeMps: number } }[],
    ticks: new Map<bigint, bigint>([[1000n, 1500n], [1500n, 2500n], [2500n, maxUint256]]), active: 1500n,
    hookRulesMinimum: 20_000_000n, hookTerms: roles.terms, quoteFee: undefined as bigint | undefined, reads: [] as ReadCall[],
  };
}
type State = ReturnType<typeof newWorld>;
type Handlers = Record<string, () => unknown>;
const pick = (label: string, handlers: Handlers, name: string) => (handlers[name] ?? (() => { throw new Error(`Unexpected ${label} read ${name}`); }))();
const struct = (c: Checkpoint) => ({ clearingPrice: c.clearingPrice, currencyRaisedAtClearingPriceQ96X7: 0n, cumulativeMpsPerPrice: 0n, cumulativeMps: 0, prev: c.prev, next: c.next });
const clearing = (w: State) => w.checkpoints.get(w.last)!.clearingPrice;
function cca(w: State, call: ReadCall): unknown {
  const [arg] = call.args as [bigint];
  return pick("auction", {
    token: () => coin, currency: () => w.roles.quote, validationHook: () => w.roles.hook, startBlock: () => w.start, endBlock: () => w.end, floorPrice: () => w.floor,
    tickSpacing: () => w.tick, isGraduated: () => w.minimumRaiseMet, lastCheckpointedBlock: () => w.last, nextActiveTickPrice: () => w.active,
    checkpoints: () => struct(w.checkpoints.get(arg) ?? { clearingPrice: 0n, prev: 0n, next: 0n }),
    ticks: () => ({ next: w.ticks.get(arg) ?? 0n, currencyDemandQ96: 0n }),
    bids: () => { const bid = w.bids.get(arg)!; return { startBlock: bid.startBlock, startCumulativeMps: 0, exitedBlock: bid.exitedBlock,
      maxPrice: bid.maxPrice, owner: bid.owner, amountQ96: bid.amountQ96, tokensFilled: 0n }; },
  }, call.functionName);
}
const hook = (w: State, call: ReadCall) => pick("hook", {
  bidRouter: () => w.roles.router, termsRegistry: () => w.hookTerms, exposureHelper: () => w.roles.exposure, MIN_BID_AMOUNT: () => w.hookRulesMinimum,
  TOKEN_CAP: () => 30_000_000n * 10n ** 18n, MAX_PRICE_LEVELS: () => 1000n, walletBids: () => w.ids,
  rules: () => [w.minimum, w.creatorExcluded ? owner : creator, w.roles.controller],
}, call.functionName);
const router = (w: State, call: ReadCall) => pick("router", {
  adapter: () => w.roles.adapter, quoteAsset: () => w.roles.quote, validationHook: () => w.roles.hook,
  quoteBid: () => { const entered = call.args[0] as bigint, fee = w.quoteFee ?? entered * 10n / 10_000n; return [entered, entered + fee, fee]; },
}, call.functionName);
const adapter = (w: State, call: ReadCall) => pick("adapter", {
  controller: () => w.roles.controller, quoteAsset: () => w.roles.quote, validationHook: () => w.roles.hook, auctionFor: () => auction,
  currentBlock: () => w.block, MAX_CCA_BID_PRICE_Q96: () => w.maxPrice,
}, call.functionName);
/** `MAX_FLOOR_PRICE_WAD` is answered only when the world models a capped controller (Gen9); a Gen8 world must never be asked for it. */
const controller = (w: State, call: ReadCall) => pick("controller", {
  feeBidRouter: () => w.roles.router, ccaAdapter: () => w.roles.adapter, quoteAsset: () => w.roles.quote, registry: () => w.roles.registry,
  termsRegistry: () => w.roles.terms, campaign: () => [creator, coin, dealId, w.end, w.open],
  ...w.floorCap === undefined ? {} : { MAX_FLOOR_PRICE_WAD: () => w.floorCap },
}, call.functionName);
function readAuctionWorld(w: State, call: ReadCall): unknown {
  w.reads.push(call);
  const r = w.roles;
  const byAddress = new Map<Address, () => unknown>([[auction, () => cca(w, call)], [r.hook, () => hook(w, call)], [r.router, () => router(w, call)],
    [r.adapter, () => adapter(w, call)], [r.controller, () => controller(w, call)], [r.terms, () => w.termsAccepted],
    [r.quote, () => call.functionName === "decimals" ? 6 : call.functionName === "balanceOf" ? w.balance : w.allowance],
    [r.registry, () => ({ creator, coin, controller: r.controller, reserveAsset: r.quote, profile: 1, status: 3 })]]);
  const handler = byAddress.get(call.address);
  if (!handler) throw new Error(`Unexpected read ${call.address} ${call.functionName}`);
  return handler();
}
function callResultOf(w: State, { to, data }: { to: Address; data: Hex }): Hex | undefined {
  if (to === auction) return encodeFunctionResult({ abi: ccaCheckpointAbi, functionName: "checkpoint", result: struct({ clearingPrice: clearing(w), prev: 0n, next: 0n }) });
  if (to === w.roles.hook && decodeFunctionData({ abi: gen8BidHookAbi, data }).functionName === "preview") {
    return encodeFunctionResult({ abi: gen8BidHookAbi, functionName: "preview", result: [w.preview.committed, w.preview.ceiling, w.preview.allowance] });
  }
  return undefined;
}
/**
 * A Gen8-family auction, its router, hook, adapter and the wallet's state, as plain fields a test can change. The default is the
 * synthetic Gen8 graph. Pass another manifest (Gen9) and its own `floorCap` to model that deployment; the world answers at its addresses.
 */
export function createAuctionWorld(deployment: AuctionManifest = manifest("gen8", 20), floorCap?: bigint) {
  const roles = rolesOf(deployment), w = newWorld(roles, floorCap);
  const chain = mockRpc(call => readAuctionWorld(w, call), { callResult: call => callResultOf(w, call), logs: () => w.logs });
  const client = () => createOxleyAuctionClient({ publicClient: chain.rpc, deployment });
  return { ...chain, world: w, deployment, roles, client };
}
export type AuctionWorld = ReturnType<typeof createAuctionWorld>;
