import { check, uint } from "./validation.js";
import type { RpcClient } from "./types.js";

/** The controller accepts 0.25 s (slowest) to 0.05 s (fastest) per block: 14,400 to 72,000 blocks per requested hour (`durationBounds(uint8)`). */
export const AUCTION_MIN_BLOCKS_PER_HOUR = 14_400;
export const AUCTION_MAX_BLOCKS_PER_HOUR = 72_000;
/** Default block-rate sample. */
export const BLOCK_RATE_SAMPLE_BLOCKS = 20_000;
const MIN_RATE_SAMPLE_BLOCKS = 1_000;

export function auctionDurationBounds(hours: number): { readonly minimumBlocks: number; readonly maximumBlocks: number } {
  check(Number.isInteger(hours) && hours >= 1 && hours <= 24, "INVALID_DURATION", "Auction duration must be 1-24 whole hours");
  return Object.freeze({ minimumBlocks: hours * AUCTION_MIN_BLOCKS_PER_HOUR, maximumBlocks: hours * AUCTION_MAX_BLOCKS_PER_HOUR });
}
/** `blocks` is an integer within the contract bounds for `hours`. */
export function checkDurationBlocks(hours: number, blocks: unknown): asserts blocks is number {
  const { minimumBlocks, maximumBlocks } = auctionDurationBounds(hours);
  check(typeof blocks === "number" && Number.isInteger(blocks) && blocks >= minimumBlocks && blocks <= maximumBlocks,
    "INVALID_DURATION_BLOCKS", `durationBlocks must be an integer from ${minimumBlocks} to ${maximumBlocks} for ${hours} h`);
}
export function blockRate(secondsPerBlock: unknown): asserts secondsPerBlock is number {
  check(typeof secondsPerBlock === "number" && Number.isFinite(secondsPerBlock) && secondsPerBlock > 0,
    "INVALID_BLOCK_RATE", "secondsPerBlock must be a finite positive number");
}
/** round(hours x 3600 / secondsPerBlock), accepted only within the contract bounds for those hours. */
export function auctionDurationBlocks(input: { hours: number; secondsPerBlock: number }): number {
  const { minimumBlocks, maximumBlocks } = auctionDurationBounds(input.hours); blockRate(input.secondsPerBlock);
  const blocks = Math.round(input.hours * 3600 / input.secondsPerBlock);
  check(blocks >= minimumBlocks && blocks <= maximumBlocks, "INVALID_DURATION_BLOCKS",
    `Observed block rate ${input.secondsPerBlock} s/block is outside the 0.05-0.25 s range the contracts accept `
    + `(${blocks} blocks for ${input.hours} h; allowed ${minimumBlocks}-${maximumBlocks})`);
  return blocks;
}
/** Average seconds per block over up to `blocks` blocks ending at `blockNumber` (default latest), never before `notBefore`. */
export async function sampleSecondsPerBlock(rpc: Pick<RpcClient, "getBlock">, options: { blocks?: number; notBefore?: bigint; blockNumber?: bigint } = {}) {
  const requested = options.blocks ?? BLOCK_RATE_SAMPLE_BLOCKS;
  check(Number.isSafeInteger(requested) && requested >= MIN_RATE_SAMPLE_BLOCKS && requested <= 1_000_000, "INVALID_SAMPLE", "Sample 1,000 to 1,000,000 blocks");
  if (options.notBefore !== undefined) uint(options.notBefore, false);
  if (options.blockNumber !== undefined) uint(options.blockNumber, false);
  const head = await rpc.getBlock(options.blockNumber === undefined ? { blockTag: "latest" } : { blockNumber: options.blockNumber });
  check(head.number !== null && head.hash !== null, "INVALID_BLOCK", "A mined head block is required");
  const floor = options.notBefore ?? 0n, available = head.number > floor ? head.number - floor : 0n;
  const blocks = available < BigInt(requested) ? available : BigInt(requested);
  check(blocks >= BigInt(MIN_RATE_SAMPLE_BLOCKS), "INSUFFICIENT_BLOCK_HISTORY",
    `Only ${blocks} blocks are available to measure the block rate; supply secondsPerBlock or durationBlocks`);
  const base = await rpc.getBlock({ blockNumber: head.number - blocks });
  check(base.number === head.number - blocks && base.timestamp < head.timestamp, "INVALID_BLOCK_RATE", "Block timestamps must increase across the sample");
  return Object.freeze({ secondsPerBlock: Number(head.timestamp - base.timestamp) / Number(blocks), blocks: Number(blocks),
    fromBlock: base.number, toBlock: head.number, fromTimestamp: base.timestamp, toTimestamp: head.timestamp });
}
