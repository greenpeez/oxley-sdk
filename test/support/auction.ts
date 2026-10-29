import { decodeFunctionData, encodeFunctionResult, maxUint256, type Address, type Hex } from "viem";
import { ccaCheckpointAbi, gen8BidHookAbi } from "../../src/gen8-abis.js";
import { createOxleyAuctionClient } from "../../src/auctions.js";
import { addr, id32, manifest, mockRpc, type ReadCall } from "./chain.js";

export const dealId = id32(0xd1), auction = addr(30), coin = addr(31), creator = addr(7), owner = addr(9);
export const [CONTROLLER, ROUTER, ADAPTER, HOOK, EXPOSURE, TERMS, REGISTRY, QUOTE] = [addr(24), addr(26), addr(27), addr(28), addr(29), addr(25), addr(22), addr(3)];
export interface Checkpoint { clearingPrice: bigint; prev: bigint; next: bigint }
export interface StoredBid { id: bigint; owner: Address; maxPrice: bigint; startBlock: bigint; amountQ96: bigint; exitedBlock: bigint }

function newWorld() {
  return {
    block: 150n, start: 100n, end: 10_000n, floor: 1000n, tick: 100n, maxPrice: 1_000_000n, open: true, minimumRaiseMet: false,
    balance: 1_000_000_000n, allowance: 0n, termsAccepted: true, creatorExcluded: false,
    minimum: 50_505_050_505n, preview: { committed: 0n, ceiling: 5_050_505_051n, allowance: 5_050_505_051n },
    ids: [] as bigint[], bids: new Map<bigint, StoredBid>(), checkpoints: new Map<bigint, Checkpoint>([[10n, { clearingPrice: 100n, prev: 0n, next: 20n }],
      [20n, { clearingPrice: 150n, prev: 10n, next: 30n }], [30n, { clearingPrice: 200n, prev: 20n, next: 0n }]]),
    last: 30n, logs: [] as { args: { blockNumber: bigint; clearingPriceQ96: bigint; cumulativeMps: number } }[],
    ticks: new Map<bigint, bigint>([[1000n, 1500n], [1500n, 2500n], [2500n, maxUint256]]), active: 1500n,
    hookRulesMinimum: 20_000_000n, hookTerms: TERMS, quoteFee: undefined as bigint | undefined, reads: [] as ReadCall[],
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
    token: () => coin, currency: () => QUOTE, validationHook: () => HOOK, startBlock: () => w.start, endBlock: () => w.end, floorPrice: () => w.floor,
    tickSpacing: () => w.tick, isGraduated: () => w.minimumRaiseMet, lastCheckpointedBlock: () => w.last, nextActiveTickPrice: () => w.active,
    checkpoints: () => struct(w.checkpoints.get(arg) ?? { clearingPrice: 0n, prev: 0n, next: 0n }),
    ticks: () => ({ next: w.ticks.get(arg) ?? 0n, currencyDemandQ96: 0n }),
    bids: () => { const bid = w.bids.get(arg)!; return { startBlock: bid.startBlock, startCumulativeMps: 0, exitedBlock: bid.exitedBlock,
      maxPrice: bid.maxPrice, owner: bid.owner, amountQ96: bid.amountQ96, tokensFilled: 0n }; },
  }, call.functionName);
}
const hook = (w: State, call: ReadCall) => pick("hook", {
  bidRouter: () => ROUTER, termsRegistry: () => w.hookTerms, exposureHelper: () => EXPOSURE, MIN_BID_AMOUNT: () => w.hookRulesMinimum,
  TOKEN_CAP: () => 30_000_000n * 10n ** 18n, MAX_PRICE_LEVELS: () => 1000n, walletBids: () => w.ids,
  rules: () => [w.minimum, w.creatorExcluded ? owner : creator, CONTROLLER],
}, call.functionName);
const router = (w: State, call: ReadCall) => pick("router", {
  adapter: () => ADAPTER, quoteAsset: () => QUOTE, validationHook: () => HOOK,
  quoteBid: () => { const entered = call.args[0] as bigint, fee = w.quoteFee ?? entered * 10n / 10_000n; return [entered, entered + fee, fee]; },
}, call.functionName);
const adapter = (w: State, call: ReadCall) => pick("adapter", {
  controller: () => CONTROLLER, quoteAsset: () => QUOTE, validationHook: () => HOOK, auctionFor: () => auction,
  currentBlock: () => w.block, MAX_CCA_BID_PRICE_Q96: () => w.maxPrice,
}, call.functionName);
const controller = (w: State, call: ReadCall) => pick("controller", {
  feeBidRouter: () => ROUTER, ccaAdapter: () => ADAPTER, quoteAsset: () => QUOTE, registry: () => REGISTRY, termsRegistry: () => TERMS,
  campaign: () => [creator, coin, dealId, w.end, w.open],
}, call.functionName);
function readAuctionWorld(w: State, call: ReadCall): unknown {
  w.reads.push(call);
  const byAddress = new Map<Address, () => unknown>([[auction, () => cca(w, call)], [HOOK, () => hook(w, call)], [ROUTER, () => router(w, call)],
    [ADAPTER, () => adapter(w, call)], [CONTROLLER, () => controller(w, call)], [TERMS, () => w.termsAccepted],
    [QUOTE, () => call.functionName === "decimals" ? 6 : call.functionName === "balanceOf" ? w.balance : w.allowance],
    [REGISTRY, () => ({ creator, coin, controller: CONTROLLER, reserveAsset: QUOTE, profile: 1, status: 3 })]]);
  const handler = byAddress.get(call.address);
  if (!handler) throw new Error(`Unexpected read ${call.address} ${call.functionName}`);
  return handler();
}
function callResultOf(w: State, { to, data }: { to: Address; data: Hex }): Hex | undefined {
  if (to === auction) return encodeFunctionResult({ abi: ccaCheckpointAbi, functionName: "checkpoint", result: struct({ clearingPrice: clearing(w), prev: 0n, next: 0n }) });
  if (to === HOOK && decodeFunctionData({ abi: gen8BidHookAbi, data }).functionName === "preview") {
    return encodeFunctionResult({ abi: gen8BidHookAbi, functionName: "preview", result: [w.preview.committed, w.preview.ceiling, w.preview.allowance] });
  }
  return undefined;
}
/** A Gen8 auction, its router, hook, adapter and the wallet's state, as plain fields a test can change. */
export function createAuctionWorld() {
  const w = newWorld();
  const chain = mockRpc(call => readAuctionWorld(w, call), { callResult: call => callResultOf(w, call), logs: () => w.logs });
  const deployment = manifest("gen8", 20);
  const client = () => createOxleyAuctionClient({ publicClient: chain.rpc, deployment });
  return { ...chain, world: w, deployment, client };
}
export type AuctionWorld = ReturnType<typeof createAuctionWorld>;
