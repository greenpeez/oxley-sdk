import { getAbiItem, type Address } from "viem";
import { ccaCheckpointAbi } from "./gen8-abis.js";
import { GEN8_MAX_WALLET_BIDS } from "./gen8-bid-rules.js";
import type { BidWitness } from "./gen8-bid-transactions.js";
import { check, OxleyError } from "./validation.js";
import type { RpcClient } from "./types.js";

export interface WitnessBid { readonly id: bigint; readonly maxPrice: bigint; readonly startBlock: bigint }
export interface Checkpoint { readonly block: bigint; readonly clearingPrice: bigint }
const LOG_RANGE = 5_000n, MAX_RANGES = 256, PARALLEL_RANGES = 8;
const unavailable = (condition: unknown) => check(condition, "WITNESS_UNAVAILABLE", "The checkpoint history needed for the bid witnesses is unavailable");

/** Dedupe by block (last write wins), sort ascending and require a non-decreasing clearing price. */
export function normalizeCheckpoints(raw: readonly Checkpoint[]): Checkpoint[] {
  const byBlock = new Map<bigint, bigint>();
  for (const { block, clearingPrice } of raw) byBlock.set(block, clearingPrice);
  const list = [...byBlock].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([block, clearingPrice]) => ({ block, clearingPrice }));
  for (let i = 1; i < list.length; i++) unavailable(list[i]!.clearingPrice >= list[i - 1]!.clearingPrice);
  return list;
}
/**
 * The hook re-reads one witness per stored bid. Witnesses name only STORED checkpoints: a bid still above the stored latest
 * clearing price gets `{ lastFull: latest, outbid: 0 }`; a bid at or below it gets its exact crossing links from the history.
 */
export function witnessFor(bid: WitnessBid, history: readonly Checkpoint[], latest: Checkpoint): BidWitness {
  if (bid.maxPrice > latest.clearingPrice) return { lastFull: latest.block, outbid: 0n };
  const list = normalizeCheckpoints([...history, latest]).filter(point => point.block >= bid.startBlock);
  let full = -1;
  list.forEach((point, index) => { if (point.clearingPrice < bid.maxPrice) full = index; });
  unavailable(full >= 0 && full + 1 < list.length);
  const outbid = list.findIndex((point, index) => index > full && point.clearingPrice > bid.maxPrice);
  return { lastFull: list[full]!.block, outbid: outbid < 0 ? 0n : list[outbid]!.block };
}
async function checkpointHistory(rpc: RpcClient, auction: Address, from: bigint, to: bigint): Promise<Checkpoint[]> {
  const ranges: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += LOG_RANGE) ranges.push([start, start + LOG_RANGE - 1n < to ? start + LOG_RANGE - 1n : to]);
  unavailable(ranges.length <= MAX_RANGES);
  const event = getAbiItem({ abi: ccaCheckpointAbi, name: "CheckpointUpdated" }), raw: Checkpoint[] = [];
  for (let offset = 0; offset < ranges.length; offset += PARALLEL_RANGES) {
    const logs = await Promise.all(ranges.slice(offset, offset + PARALLEL_RANGES)
      .map(([fromBlock, toBlock]) => rpc.getLogs({ address: auction, event, fromBlock, toBlock, strict: true })));
    for (const log of logs.flat()) raw.push({ block: log.args.blockNumber, clearingPrice: log.args.clearingPriceQ96 });
  }
  return raw;
}
/** The contract's own witness conditions, checked against stored checkpoints before the witness is used. */
async function verifyWitness(rpc: RpcClient, auction: Address, bid: WitnessBid, witness: BidWitness, latest: Checkpoint, blockNumber: bigint) {
  const read = (block: bigint) => rpc.readContract({ address: auction, abi: ccaCheckpointAbi, functionName: "checkpoints", args: [block], blockNumber });
  const full = await read(witness.lastFull);
  if (bid.maxPrice > latest.clearingPrice) return unavailable(full.clearingPrice < bid.maxPrice);
  unavailable(witness.lastFull >= bid.startBlock && full.clearingPrice < bid.maxPrice && full.next !== 0n);
  unavailable((await read(full.next)).clearingPrice >= bid.maxPrice);
  if (witness.outbid === 0n) return unavailable(latest.clearingPrice === bid.maxPrice);
  const outbid = await read(witness.outbid);
  unavailable(outbid.clearingPrice > bid.maxPrice && outbid.prev !== 0n && (await read(outbid.prev)).clearingPrice <= bid.maxPrice);
}
/** One verified witness per bid, in the order given, read at `blockNumber`. */
export async function loadWitnesses(rpc: RpcClient, auction: Address, bids: readonly WitnessBid[], blockNumber: bigint): Promise<BidWitness[]> {
  if (bids.length > GEN8_MAX_WALLET_BIDS) throw new OxleyError("WITNESS_UNAVAILABLE", "A wallet has at most 12 bids on an auction");
  const last = await rpc.readContract({ address: auction, abi: ccaCheckpointAbi, functionName: "lastCheckpointedBlock", blockNumber });
  const stored = await rpc.readContract({ address: auction, abi: ccaCheckpointAbi, functionName: "checkpoints", args: [last], blockNumber });
  const latest = { block: last, clearingPrice: stored.clearingPrice };
  const outbid = bids.filter(bid => bid.maxPrice <= latest.clearingPrice);
  const from = outbid.reduce((low, bid) => (bid.startBlock < low ? bid.startBlock : low), last);
  const history = outbid.length ? await checkpointHistory(rpc, auction, from, last) : [];
  const witnesses = bids.map(bid => witnessFor(bid, history, latest));
  await Promise.all(bids.map((bid, index) => verifyWitness(rpc, auction, bid, witnesses[index]!, latest, blockNumber)));
  return witnesses;
}
