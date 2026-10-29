import type { Address, Hex } from "viem";
import { createOxleyClient, type OxleyClient } from "./client.js";
import { testnetDeployments } from "./testnet-deployments.js";
import { createMarketDiscovery } from "./markets-discovery.js";
import { address, check, deploymentGeneration, hash, OxleyError, parseDeployment, sameAddress } from "./validation.js";
import type { Deployment, DeploymentGeneration, QuoteRequest, RpcClient, Swap } from "./types.js";
import type { SwapFeeRequest } from "./client-fee-swaps.js";
import type { SwapWithFee } from "./swap-fee.js";

/** The data API's `deploymentIdentity` (or any equivalent). It only selects a candidate; the chain still has to confirm the market. */
export interface DeploymentIdentityHint {
  chainId?: number; curve: { address: string; runtimeCodeHash?: string };
  /** When present they must match the reviewed controller and quote token. `releaseId` and `source` are informational and not compared. */
  controller?: { address: string; runtimeCodeHash?: string }; quote?: { address: string; runtimeCodeHash?: string };
}
export interface MarketGeneration {
  readonly generation: DeploymentGeneration; readonly releaseId: string; readonly status: string | null;
  readonly curve: Address; readonly startBlock: string;
}
/** A reported contract binds to a reviewed pin when its address (and runtime hash, if reported) are the pin's. */
const boundTo = (reported: { address: string; runtimeCodeHash?: string } | undefined, address: string, runtimeCodeHash?: string) =>
  reported === undefined || sameAddress(reported.address, address) && (reported.runtimeCodeHash === undefined || runtimeCodeHash === undefined
    || sameAddress(reported.runtimeCodeHash, runtimeCodeHash));
interface Entry extends MarketGeneration { readonly deployment: Deployment; readonly client: OxleyClient }

/**
 * Trading across every reviewed generation. A market is resolved on chain: each generation's curve and registry must list the
 * deal ID as an active, registered market of that generation. Nothing is guessed from symbols, addresses or an API response.
 */
export function createOxleyMarkets(options: { publicClient: RpcClient; deployments?: readonly unknown[] }) {
  const parsed = (options.deployments ?? testnetDeployments).map(item => parseDeployment(item));
  check(parsed.length > 0, "INVALID_DEPLOYMENT", "At least one reviewed deployment is required");
  check(new Set(parsed.map(d => d.releaseId)).size === parsed.length && new Set(parsed.map(d => d.curve.address.toLowerCase())).size === parsed.length
    && new Set(parsed.map(d => d.chainId)).size === 1, "INVALID_DEPLOYMENT", "Deployments must be distinct releases on one chain");
  const entries: readonly Entry[] = parsed.map(deployment => Object.freeze({ deployment, generation: deploymentGeneration(deployment),
    releaseId: deployment.releaseId, status: deployment.status ?? null, curve: deployment.curve.address, startBlock: deployment.startBlock,
    client: createOxleyClient({ publicClient: options.publicClient, deployment }) }));
  const generations: readonly MarketGeneration[] = entries.map(({ generation, releaseId, status, curve, startBlock }) => ({ generation, releaseId, status, curve, startBlock }));
  const known = new Map<string, Entry>();

  function entryFor(identifier: string): Entry {
    const found = entries.find(entry => entry.releaseId === identifier || entry.generation === identifier);
    if (!found) throw new OxleyError("UNKNOWN_DEPLOYMENT", `No reviewed deployment is named ${identifier}`);
    return found;
  }
  function entryForIdentity(identity: DeploymentIdentityHint): Entry {
    address(identity.curve?.address);
    const found = entries.find(({ deployment }) => sameAddress(deployment.curve.address, identity.curve.address)
      && (identity.chainId === undefined || identity.chainId === deployment.chainId)
      && boundTo(identity.curve, deployment.curve.address, deployment.curve.runtimeCodeHash)
      && boundTo(identity.controller, deployment.auctionController, (deployment as { auctionBindings?: { controllerRuntimeCodeHash?: string } }).auctionBindings?.controllerRuntimeCodeHash)
      && boundTo(identity.quote, deployment.quoteToken.address, deployment.quoteToken.runtimeCodeHash));
    if (!found) throw new OxleyError("UNKNOWN_DEPLOYMENT", "The deployment identity does not match any reviewed curve");
    return found;
  }
  /** Resolves the deal on chain; `identity` narrows the search to one generation but never replaces the on-chain check. */
  async function resolveMarket(marketId: Hex, resolution: { identity?: DeploymentIdentityHint } = {}) {
    hash(marketId);
    const key = marketId.toLowerCase(), hinted = resolution.identity ? entryForIdentity(resolution.identity) : known.get(key);
    const candidates = hinted ? [hinted] : entries;
    const settled = await Promise.allSettled(candidates.map(async entry => ({ entry, ...await entry.client.getMarket(marketId) })));
    const matches = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    if (matches.length > 1) throw new OxleyError("AMBIGUOUS_MARKET", "More than one reviewed generation lists this market", { marketId });
    if (matches[0]) { known.set(key, matches[0].entry); return matches[0]; }
    const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    // A failed read or verification is not "not found": surface it instead of hiding it behind a missing market.
    const other = failures.find(reason => !(reason instanceof OxleyError && reason.code === "UNSUPPORTED_MARKET"));
    if (other) throw other;
    throw new OxleyError(resolution.identity ? "IDENTITY_MISMATCH" : "UNSUPPORTED_MARKET",
      "No reviewed deployment lists this market as active and registered", { marketId, checked: candidates.map(entry => entry.releaseId) });
  }
  const clientOf = async (marketId: Hex) => (await resolveMarket(marketId)).entry.client;
  const swapClient = (swap: Swap | SwapWithFee) => entryFor(("swap" in swap ? swap.swap : swap).quote.releaseId).client;
  async function verifyDeployments() {
    return Promise.all(entries.map(async entry => ({ generation: entry.generation, releaseId: entry.releaseId, ...await entry.client.verifyDeployment() })));
  }
  const discoverMarkets = createMarketDiscovery(entries);
  return { generations, client: (identifier: string) => entryFor(identifier).client, verifyDeployments, resolveMarket, discoverMarkets,
    quote: async (request: QuoteRequest) => (await clientOf(request.marketId)).quote(request),
    getTradingStatus: async (marketId: Hex, blockNumber?: bigint) => (await clientOf(marketId)).getTradingStatus(marketId, blockNumber),
    prepareSwap: async (request: Parameters<OxleyClient["prepareSwap"]>[0]) => (await clientOf(request.marketId)).prepareSwap(request),
    checkSwap: async (swap: Swap, simulate = false) => swapClient(swap).checkSwap(swap, simulate),
    prepareSwapWithFee: async (request: SwapFeeRequest) => (await clientOf(request.marketId)).prepareSwapWithFee(request),
    checkSwapWithFee: async (prepared: SwapWithFee, simulate = false) => swapClient(prepared).checkSwapWithFee(prepared, simulate),
    getTermsStatus: async (input: { marketId: Hex; account: Address; blockNumber?: bigint }) =>
      (await clientOf(input.marketId)).getTermsStatus(input.account, input.blockNumber),
    prepareAcceptTerms: async (input: { marketId: Hex; account: Address }) => (await clientOf(input.marketId)).prepareAcceptTerms(input) };
}
export type OxleyMarkets = ReturnType<typeof createOxleyMarkets>;
