import { encodeFunctionData, keccak256, parseAbiItem, type Address, type Hex } from "viem";
import { curveAbi, registryAbi, tokenAbi } from "./abis.js";
import { buildApprovals, buildSwap } from "./transactions.js";
import { address, check, hash, OxleyError, parseDeployment, sameAddress, uint } from "./validation.js";
import type { Anchor, DiscoveryCursor, Market, Quote, QuoteRequest, RpcClient, Swap } from "./types.js";

type DiscoveryOptions = { cursor?: DiscoveryCursor; fromBlock?: bigint; toBlock?: bigint; pageSize?: number; coin?: Address };

// The nested operations deliberately share one deployment verification cache.
// eslint-disable-next-line max-lines-per-function
export function createOxleyClient(options: { publicClient: RpcClient; deployment: unknown }) {
  const rpc = options.publicClient;
  const deployment = parseDeployment(options.deployment);
  const startBlock = BigInt(deployment.startBlock);

  async function snapshot(blockNumber?: bigint): Promise<Anchor> {
    if (blockNumber !== undefined) uint(blockNumber, false);
    const [chainId, block] = await Promise.all([
      rpc.getChainId(), rpc.getBlock(blockNumber === undefined ? { blockTag: "latest" } : { blockNumber }),
    ]);
    check(chainId === deployment.chainId, "CHAIN_MISMATCH", "RPC chain does not match the deployment");
    check(block.number !== null && block.hash !== null && block.number >= startBlock,
      "INVALID_BLOCK", "A mined block after deployment is required");
    return { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp };
  }
  async function assertCanonical(anchor: Anchor): Promise<void> {
    const block = await rpc.getBlock({ blockNumber: anchor.blockNumber });
    check(block.hash === anchor.blockHash, "REORG", "Quote/discovery block changed; discard results and retry");
  }

  // Immutable deployments are checked at connection; callers can explicitly recheck at any time.
  let verified: Promise<void> | undefined;
  async function verifyAt(anchor: Anchor): Promise<void> {
    await Promise.all([deployment.curve, deployment.registry, deployment.quoteToken].map(async pin => {
      const code = await rpc.getCode({ address: pin.address, blockNumber: anchor.blockNumber });
      check(code && code !== "0x" && keccak256(code).toLowerCase() === pin.runtimeCodeHash.toLowerCase(),
        "CODE_MISMATCH", `Runtime code differs at ${pin.address}`);
    }));
    const [quoteToken, decimals] = await Promise.all([
      rpc.readContract({ address: deployment.curve.address, abi: curveAbi, functionName: "quoteAsset", blockNumber: anchor.blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "decimals", blockNumber: anchor.blockNumber }),
    ]);
    check(sameAddress(quoteToken, deployment.quoteToken.address) && decimals === 6,
      "QUOTE_BINDING_MISMATCH", "Curve quote token or decimals do not match the manifest");
    await assertCanonical(anchor);
  }
  async function ensureVerified(anchor: Anchor): Promise<void> {
    if (!verified) verified = verifyAt(anchor).catch(error => { verified = undefined; throw error; });
    await verified;
  }
  async function verifyDeployment() {
    const anchor = await snapshot();
    await verifyAt(anchor);
    verified = Promise.resolve();
    return { deployment, ...anchor };
  }

  async function marketAt(id: Hex, anchor: Anchor): Promise<Market> {
    hash(id);
    const [deal, market] = await Promise.all([
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [id], blockNumber: anchor.blockNumber }),
      rpc.readContract({ address: deployment.curve.address, abi: curveAbi, functionName: "market", args: [id], blockNumber: anchor.blockNumber }),
    ]);
    check(deal.profile === 1 && deal.status === 3 && market.active
      && sameAddress(deal.controller, deployment.auctionController)
      && sameAddress(deal.coin, market.coin) && sameAddress(deal.creator, market.creator)
      && sameAddress(deal.reserveAsset, deployment.quoteToken.address)
      && sameAddress(market.reserveAsset, deployment.quoteToken.address),
    "UNSUPPORTED_MARKET", "Only active, registered USDC auction markets are supported");
    address(market.coin);
    check(!sameAddress(market.coin, deployment.quoteToken.address), "UNSUPPORTED_MARKET", "Invalid market pair");
    const coinDecimals = await rpc.readContract({ address: market.coin, abi: tokenAbi, functionName: "decimals", blockNumber: anchor.blockNumber });
    check(coinDecimals === 18, "UNSUPPORTED_MARKET", "Unexpected auction coin precision");
    return Object.freeze({ id, coin: market.coin, coinDecimals, creator: market.creator,
      activatedAt: market.activatedAt, quoteToken: deployment.quoteToken.address, curve: deployment.curve.address });
  }
  async function getMarket(id: Hex, blockNumber?: bigint) {
    const anchor = await snapshot(blockNumber);
    await ensureVerified(anchor);
    const market = await marketAt(id, anchor);
    await assertCanonical(anchor);
    return { market, ...anchor };
  }

  async function quoteAt(request: QuoteRequest, anchor: Anchor, markets?: Map<string, Promise<Market>>): Promise<Quote> {
    uint(request.amountIn); address(request.caller); address(request.tokenIn); address(request.tokenOut);
    hash(request.marketId);
    const key = request.marketId.toLowerCase();
    const pendingMarket = markets?.get(key) ?? marketAt(request.marketId, anchor);
    markets?.set(key, pendingMarket);
    const market = await pendingMarket;
    const buy = sameAddress(request.tokenIn, market.quoteToken) && sameAddress(request.tokenOut, market.coin);
    const sell = sameAddress(request.tokenIn, market.coin) && sameAddress(request.tokenOut, market.quoteToken);
    check(buy || sell, "UNSUPPORTED_PAIR", "Only the market coin/USDC pair is supported");
    let amountOut: bigint;
    let feeAmount: bigint;
    if (buy) {
      [amountOut, feeAmount] = await rpc.readContract({ address: market.curve, abi: curveAbi, functionName: "quoteBuy",
        args: [market.id, request.amountIn, request.caller], blockNumber: anchor.blockNumber });
    } else {
      let collateralOut: bigint;
      [amountOut, collateralOut, feeAmount] = await rpc.readContract({ address: market.curve, abi: curveAbi, functionName: "quoteSell",
        args: [market.id, request.amountIn, request.caller], blockNumber: anchor.blockNumber });
      check(collateralOut === 0n, "COLLATERAL_OUTPUT", "This sell includes a non-swap collateral redemption");
    }
    check(amountOut > 0n, "ZERO_OUTPUT", "Quote has no executable output");
    return Object.freeze({ ...anchor, chainId: deployment.chainId, releaseId: deployment.releaseId, market,
      side: buy ? "buy" : "sell", caller: request.caller, tokenIn: request.tokenIn, tokenOut: request.tokenOut,
      amountIn: request.amountIn, amountOut, feeAmount, feeToken: market.quoteToken });
  }
  async function quote(request: QuoteRequest) {
    const anchor = await snapshot(request.blockNumber);
    await ensureVerified(anchor);
    const result = await quoteAt(request, anchor);
    await assertCanonical(anchor);
    return result;
  }
  async function quoteMany(requests: readonly Omit<QuoteRequest, "blockNumber">[], blockNumber?: bigint) {
    check(requests.length > 0 && requests.length <= 64, "BATCH_SIZE", "Quote batches support 1 to 64 samples");
    const anchor = await snapshot(blockNumber);
    await ensureVerified(anchor);
    const results: PromiseSettledResult<Quote>[] = [];
    const markets = new Map<string, Promise<Market>>();
    // Bound RPC concurrency; failures remain errors, never plausible zero-price quotes.
    for (let i = 0; i < requests.length; i += 4) {
      results.push(...await Promise.allSettled(requests.slice(i, i + 4).map(request => quoteAt(request, anchor, markets))));
    }
    await assertCanonical(anchor);
    return { ...anchor, results };
  }

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

  async function prepareSwap(request: Omit<QuoteRequest, "blockNumber"> & { slippageBps: number; ttlSeconds?: number }) {
    const ttl = request.ttlSeconds ?? 300;
    check(Number.isInteger(ttl) && ttl > 0 && ttl <= 3600, "INVALID_TTL", "Swap lifetime must be 1 to 3600 seconds");
    const quoted = await quote({ ...request, blockNumber: undefined });
    return buildSwap(quoted, { slippageBps: request.slippageBps, deadline: quoted.timestamp + BigInt(ttl) });
  }

  async function checkSwap(swap: Swap, simulate = false) {
    uint(swap.minAmountOut); uint(swap.deadline);
    check(swap.quote.chainId === deployment.chainId && swap.quote.releaseId === deployment.releaseId
      && sameAddress(swap.transaction.to, deployment.curve.address), "SWAP_MISMATCH", "Swap belongs to another deployment");
    // Reconstruct the request, rather than simulate an arbitrary target/calldata supplied by a consumer.
    const anchor = await snapshot();
    await ensureVerified(anchor);
    check(anchor.timestamp < swap.deadline, "EXPIRED_DEADLINE", "Requote the expired swap");
    const current = await quoteAt({ marketId: swap.quote.market.id, tokenIn: swap.quote.tokenIn,
      tokenOut: swap.quote.tokenOut, amountIn: swap.quote.amountIn, caller: swap.quote.caller }, anchor);
    check(current.amountOut >= swap.minAmountOut, "SLIPPAGE", "Current output is below the swap minimum");
    const expected = current.side === "buy"
      ? encodeFunctionData({ abi: curveAbi, functionName: "buy", args: [current.market.id, current.amountIn, swap.minAmountOut, swap.deadline] })
      : encodeFunctionData({ abi: curveAbi, functionName: "sell", args: [current.market.id, current.amountIn, swap.minAmountOut, 0n, swap.deadline] });
    check(swap.transaction.data === expected && swap.transaction.value === 0n
      && swap.transaction.chainId === deployment.chainId, "SWAP_MISMATCH", "Swap transaction does not match its quote");
    const [balance, allowance] = await Promise.all([
      rpc.readContract({ address: current.tokenIn, abi: tokenAbi, functionName: "balanceOf", args: [current.caller], blockNumber: anchor.blockNumber }),
      rpc.readContract({ address: current.tokenIn, abi: tokenAbi, functionName: "allowance", args: [current.caller, deployment.curve.address], blockNumber: anchor.blockNumber }),
    ]);
    const canonical = { ...swap, allowance: { token: current.tokenIn, owner: current.caller, spender: deployment.curve.address, amount: current.amountIn } };
    const approvals = buildApprovals(canonical, allowance);
    let gas: bigint | undefined;
    if (simulate) {
      check(balance >= current.amountIn, "INSUFFICIENT_BALANCE", "Caller needs input tokens before simulation");
      check(approvals.length === 0, "APPROVAL_REQUIRED", "Confirm required approvals before simulating the swap");
      const call = { to: deployment.curve.address, data: expected, account: current.caller, value: 0n, blockNumber: anchor.blockNumber };
      await rpc.call(call);
      gas = await rpc.estimateGas(call);
    }
    await assertCanonical(anchor);
    return { ...anchor, balance, allowance, approvals, sufficientBalance: balance >= current.amountIn, gas };
  }
  return { deployment, verifyDeployment, getMarket, quote, quoteMany, discoverMarkets, prepareSwap, checkSwap };
}
