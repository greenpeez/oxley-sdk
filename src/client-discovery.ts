import { parseAbiItem, type Address } from "viem";
import { address, check, hash, OxleyError, sameAddress, uint } from "./validation.js";
import type { Anchor, DiscoveryCursor, Market } from "./types.js";
import type { ClientContext } from "./client-context.js";
import type { MarketReader } from "./client-market.js";

export type DiscoveryOptions = { cursor?: DiscoveryCursor; fromBlock?: bigint; toBlock?: bigint; pageSize?: number; coin?: Address };

export function createDiscoveryReader(context: ClientContext, marketReader: MarketReader) {
  const { rpc, deployment, startBlock, snapshot, assertCanonical, ensureVerified } = context;
  const { marketAt } = marketReader;
  async function cursorStart(c: DiscoveryCursor): Promise<bigint> {
    check(c.chainId === deployment.chainId && c.releaseId === deployment.releaseId && sameAddress(c.curve, deployment.curve.address)
      && /^(0|[1-9][0-9]*)$/.test(c.blockNumber), "INVALID_CURSOR", "Cursor belongs to another deployment or is malformed");
    hash(c.blockHash);
    const previous = await rpc.getBlock({ blockNumber: BigInt(c.blockNumber) });
    check(previous.hash === c.blockHash, "REORG", "Discovery cursor was reorganized; replay from the last canonical cursor");
    return BigInt(c.blockNumber) + 1n;
  }
  async function discoveryRange(options: DiscoveryOptions, anchor: Anchor) {
    check(!options.cursor || options.fromBlock === undefined, "INVALID_CURSOR", "Use cursor or fromBlock, not both");
    const size = options.pageSize ?? 1000;
    check(Number.isSafeInteger(size) && size >= 1 && size <= 10_000, "INVALID_PAGE_SIZE", "Page size must be 1 to 10000 blocks");
    if (options.coin) address(options.coin);
    const fromBlock = options.cursor ? await cursorStart(options.cursor) : options.fromBlock ?? startBlock;
    uint(fromBlock, false);
    check(fromBlock >= startBlock && fromBlock <= anchor.blockNumber + 1n, "INVALID_RANGE", "Discovery range is outside the deployment history");
    const end = fromBlock + BigInt(size) - 1n;
    const toBlock = end < anchor.blockNumber ? end : anchor.blockNumber;
    return { fromBlock, toBlock };
  }
  async function discoverMarkets(options: DiscoveryOptions = {}) {
    const anchor = await snapshot(options.toBlock);
    await ensureVerified(anchor);
    const { fromBlock, toBlock } = await discoveryRange(options, anchor);
    const checkpoint = await rpc.getBlock({ blockNumber: toBlock });
    check(checkpoint.hash, "INVALID_BLOCK", "Discovery requires a mined checkpoint");
    const logs = fromBlock > toBlock ? [] : await rpc.getLogs({ address: deployment.curve.address,
      event: parseAbiItem("event MarketActivated(bytes32 indexed dealId,address indexed coin,address indexed creator,address reserveAsset,uint256 quoteSeed)"),
      args: options.coin ? { coin: options.coin } : undefined, fromBlock, toBlock, strict: true });
    const ids = [...new Set(logs.filter(log => !log.removed).map(log => log.args.dealId))];
    const markets: Market[] = [];
    for (let i = 0; i < ids.length; i += 4) {
      const values = await Promise.all(ids.slice(i, i + 4).map(async id => {
        try { return await marketAt(id, anchor); }
        catch (error) { if (error instanceof OxleyError && error.code === "UNSUPPORTED_MARKET") return null; throw error; }
      }));
      markets.push(...values.filter((value): value is Market => value !== null));
    }
    await assertCanonical({ blockNumber: toBlock, blockHash: checkpoint.hash, timestamp: checkpoint.timestamp });
    await assertCanonical(anchor);
    const cursor: DiscoveryCursor = { chainId: deployment.chainId, releaseId: deployment.releaseId,
      curve: deployment.curve.address, blockNumber: toBlock.toString(), blockHash: checkpoint.hash };
    return { markets, cursor, hasMore: toBlock < anchor.blockNumber, ...anchor };
  }

  return discoverMarkets;
}
