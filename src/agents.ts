import { getAddress, isAddress } from "viem";
import { AgentApiError, agentCall, type HttpOptions, type Transport } from "./agents-http.js";
import type { Address, AgentIntegratorFee, AgentKeyIssued, AgentKeyRequest, AgentRequestOptions, AgentStanding, AgentStep, BridgeBuild, BridgeBuildRequest, BridgeConfig,
  BridgeIntent, BridgeQuote, BridgeStatus, BridgeStatusRequest, Hash, ReportResult, SwapBuild, SwapBuildRequest, SwapPrice, SwapPriceQuery, SwapStatus, SwapToken } from "./agents-types.js";
export { AgentApiError } from "./agents-http.js";
export type * from "./agents-types.js";

/**
 * The Oxley Agent API: swaps on Elysium (the best of 0x's routes and Nest's pools) and the bridge between Elysium, Ethereum, Arbitrum, Base, BNB, HyperEVM, Robinhood Chain and
 * to Solana, for agents and bots, with an API key whose limits rise with the volume it brings. Fetch-only: every build comes back as unsigned transactions that the caller's own
 * wallet signs and sends. The SDK holds no key and no funds; `requestAgentApiKey` asks the caller's signer for one signature of the key message.
 */
export const OXLEY_AGENT_API_URL = "https://oxley-agents.web3bandit.workers.dev";
/** Swap's chain: Elysium mainnet. */
export const AGENT_SWAP_CHAIN_ID = 99901;
/** How far the key message's time may be from the server's clock. */
export const AGENT_KEY_ISSUE_WINDOW_MS = 600_000;
/** The live keys one wallet may hold. */
export const MAX_AGENT_KEYS = 3;
export const MIN_SLIPPAGE_BPS = 10, MAX_SLIPPAGE_BPS = 500;

export type AgentClientOptions = Readonly<{
  /** The `oxk_` key. Only `issueKey` and `openApi` work without one. */
  apiKey?: string;
  /** The API root (default `OXLEY_AGENT_API_URL`). HTTPS except on localhost. */
  baseUrl?: string;
  fetch?: Transport;
  /** Per attempt, default 30 000 ms (a bridge quote asks several providers). */
  timeoutMs?: number;
  /** How many times a 429 is waited out and sent again (default 1, at most 5). */
  retries?: number;
  /** The longest `retry-after` waited out (default 10 000 ms); a longer one is thrown with `retryAfterMs`. */
  maxRetryWaitMs?: number;
}>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u, UNITS = /^[1-9]\d{0,77}$/u, HASH = /^0x[0-9a-fA-F]{64}$/u, KEY = /^oxk_[A-Za-z0-9_-]{43}$/u, HEX = /^0x(?:[0-9a-fA-F]{2})*$/u, DECIMAL = /^\d{1,78}$/u;
const invalid = (reason: string): never => { throw new AgentApiError("INVALID_REQUEST", 0, reason); };
const integerIn = (value: unknown, low: number, high: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;

function rootOf(baseUrl: string): URL {
  let root: URL;
  try { root = new URL(baseUrl); } catch { throw new AgentApiError("INVALID_CLIENT_OPTIONS", 0, "baseUrl is not a URL."); }
  const local = root.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(root.hostname);
  if (root.username || root.password || root.search || root.hash || !(root.protocol === "https:" || local)) throw new AgentApiError("INVALID_CLIENT_OPTIONS", 0, "baseUrl must be an https URL with no credentials, query or fragment.");
  root.pathname = `${root.pathname.replace(/\/$/u, "")}/`;
  return root;
}
function httpOptions(options: AgentClientOptions): HttpOptions {
  const timeoutMs = options.timeoutMs ?? 30_000, retries = options.retries ?? 1, maxRetryWaitMs = options.maxRetryWaitMs ?? 10_000;
  if (options.apiKey !== undefined && !KEY.test(options.apiKey)) throw new AgentApiError("INVALID_CLIENT_OPTIONS", 0, "apiKey is an oxk_ key.");
  if (!integerIn(timeoutMs, 1, 120_000) || !integerIn(retries, 0, 5) || !integerIn(maxRetryWaitMs, 0, 120_000)) throw new AgentApiError("INVALID_CLIENT_OPTIONS", 0, "timeoutMs, retries or maxRetryWaitMs is out of range.");
  return { root: rootOf(options.baseUrl ?? OXLEY_AGENT_API_URL), apiKey: options.apiKey, fetch: options.fetch, timeoutMs, retries, maxRetryWaitMs };
}

function checkFee(fee: AgentIntegratorFee | undefined) {
  if (fee === undefined) return;
  if (!fee || !ADDRESS.test(String(fee.recipient)) || !integerIn(fee.bps, 1, 10_000)) invalid("integratorFee is { recipient, bps }: an address and whole basis points (at most the key's tier cap).");
}
function checkSlippage(slippageBps: number | undefined) {
  if (slippageBps !== undefined && !integerIn(slippageBps, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)) invalid(`slippageBps is a whole number from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}.`);
}
function checkSwap(ask: SwapPriceQuery, takerRequired: boolean) {
  if (!ADDRESS.test(String(ask.sellToken)) || !ADDRESS.test(String(ask.buyToken))) invalid("sellToken and buyToken are token addresses.");
  if (!UNITS.test(String(ask.sellAmount))) invalid("sellAmount is a positive amount in base units, as a decimal string.");
  if ((takerRequired || ask.taker !== undefined) && !ADDRESS.test(String(ask.taker))) invalid("taker is the address that sends the swap.");
  checkSlippage(ask.slippageBps); checkFee(ask.integratorFee);
}
function checkIntent(intent: BridgeIntent) {
  if (!ADDRESS.test(String(intent.account)) || !ADDRESS.test(String(intent.tokenIn))) invalid("account and tokenIn are addresses (a transfer starts on an EVM chain).");
  if (typeof intent.recipient !== "string" || !intent.recipient || typeof intent.tokenOut !== "string" || !intent.tokenOut) invalid("recipient and tokenOut are required.");
  if (!integerIn(intent.sourceChainId, 1, Number.MAX_SAFE_INTEGER) || !integerIn(intent.destinationChainId, 1, Number.MAX_SAFE_INTEGER)) invalid("sourceChainId and destinationChainId are chain ids.");
  if (!UNITS.test(String(intent.amountIn))) invalid("amountIn is a positive amount in base units, as a decimal string.");
  checkSlippage(intent.slippageBps); checkFee(intent.integratorFee);
}
const checkHash = (hash: unknown, name: string) => { if (!HASH.test(String(hash))) invalid(`${name} is a 32-byte transaction hash.`); };
function priceQuery(ask: SwapPriceQuery): URLSearchParams {
  const query = new URLSearchParams({ sellToken: ask.sellToken, buyToken: ask.buyToken, sellAmount: ask.sellAmount });
  if (ask.taker) query.set("taker", ask.taker);
  if (ask.slippageBps !== undefined) query.set("slippageBps", String(ask.slippageBps));
  if (ask.integratorFee) { query.set("integratorFeeRecipient", ask.integratorFee.recipient); query.set("integratorFeeBps", String(ask.integratorFee.bps)); }
  return query;
}

/** The message a wallet signs (EIP-191 `personal_sign`) to be issued a key: its checksummed address and the time, as `toISOString` writes it. */
export function agentKeyMessage(address: string, issuedAt: string): string {
  if (!isAddress(address, { strict: false })) invalid("address is not an address.");
  return `Oxley API key\nAddress: ${getAddress(address)}\nIssued at: ${issuedAt}`;
}
/** The key request to sign: the checksummed address, the time now and the exact message. Sign `message`, then send `{ address, issuedAt, signature }` with `issueKey`. */
export function prepareAgentKeyRequest(address: string, now = Date.now()): Readonly<{ address: Address; issuedAt: string; message: string }> {
  if (!isAddress(address, { strict: false })) invalid("address is not an address.");
  const checksummed = getAddress(address), issuedAt = new Date(now).toISOString();
  return { address: checksummed, issuedAt, message: agentKeyMessage(checksummed, issuedAt) };
}
/** Anything that can sign a message for its address: a viem local account (`privateKeyToAccount`), or `{ address, signMessage: ({ message }) => walletClient.signMessage({ account, message }) }`. */
export type AgentKeySigner = Readonly<{ address: Address; signMessage(args: { message: string }): Promise<`0x${string}`> }>;

export function createOxleyAgentClient(options: AgentClientOptions = {}) {
  const http = httpOptions(options);
  const get = <T>(path: string, request?: AgentRequestOptions, query?: URLSearchParams, auth = true) => agentCall<T>(http, { method: "GET", path, query, auth, signal: request?.signal });
  const post = <T>(path: string, body: unknown, request?: AgentRequestOptions, auth = true) => agentCall<T>(http, { method: "POST", path, body, auth, signal: request?.signal });
  return {
    /** `POST /v1/keys`: issues a key for a signed key request (no key needed). The key is shown once; at most three live keys per wallet; EOA signatures only. */
    issueKey(ask: AgentKeyRequest, request?: AgentRequestOptions): Promise<AgentKeyIssued> {
      if (!ADDRESS.test(String(ask.address)) || !/^0x[0-9a-fA-F]{130}$/u.test(String(ask.signature)) || typeof ask.issuedAt !== "string") invalid("Send { address, issuedAt, signature }: the key message signed by the address.");
      return post("/v1/keys", { address: ask.address, issuedAt: ask.issuedAt, signature: ask.signature }, request, false);
    },
    /** `GET /v1/me`: the key's tier, limits, 30-day volume and the next tier. */
    me: (request?: AgentRequestOptions) => get<AgentStanding>("/v1/me", request),
    /** `DELETE /v1/keys/self`: revokes this client's key. */
    revokeKey: (request?: AgentRequestOptions) => agentCall<Readonly<{ revoked: boolean }>>(http, { method: "DELETE", path: "/v1/keys/self", auth: true, signal: request?.signal }),
    /** `GET /v1/swap/tokens`: Swap's listed tokens on Elysium and whether Swap is ready. */
    swapTokens: (request?: AgentRequestOptions) => get<Readonly<{ ready: boolean; reason: string | null; tokens: readonly SwapToken[] }> & Readonly<Record<string, unknown>>>("/v1/swap/tokens", request),
    /** `GET /v1/swap/price`: an indicative price, the best of 0x's routes and Nest's pools, after every fee (a quote call). */
    swapPrice(ask: SwapPriceQuery, request?: AgentRequestOptions): Promise<SwapPrice> { checkSwap(ask, false); return get("/v1/swap/price", request, priceQuery(ask)); },
    /** `POST /v1/swap/build`: the swap's unsigned steps for `taker` (an integrator fee transfer first on a Nest pool route, the approvals still needed, the swap last) and its buildId. */
    buildSwap(ask: SwapBuildRequest, request?: AgentRequestOptions): Promise<SwapBuild> { checkSwap(ask, true); return post("/v1/swap/build", ask, request); },
    /** `GET /v1/swap/status`: whether a sent swap succeeded; with its buildId it also counts the swap's volume (`report`). */
    swapStatus(ask: Readonly<{ hash: Hash; buildId?: string }>, request?: AgentRequestOptions): Promise<SwapStatus> {
      checkHash(ask.hash, "hash");
      return get("/v1/swap/status", request, new URLSearchParams({ hash: ask.hash, ...ask.buildId ? { buildId: ask.buildId } : {} }));
    },
    /** `GET /v1/bridge/config`: the chains, tokens and lanes the bridge serves. */
    bridgeConfig: (request?: AgentRequestOptions) => get<BridgeConfig>("/v1/bridge/config", request),
    /** `POST /v1/bridge/quote`: a quote for every hop of a transfer, after every fee (a quote call). */
    bridgeQuote(intent: BridgeIntent, request?: AgentRequestOptions): Promise<BridgeQuote> { checkIntent(intent); return post("/v1/bridge/quote", intent, request); },
    /** `POST /v1/bridge/build`: the first leg's unsigned steps (an integrator fee transfer first, the approvals, the transaction last) and its buildId. Pass `via` from the quote's first leg. */
    buildBridge(ask: BridgeBuildRequest, request?: AgentRequestOptions): Promise<BridgeBuild> { checkIntent(ask); return post("/v1/bridge/build", ask, request); },
    /** `POST /v1/bridge/status`: a sent transfer's progress; with its buildId it also counts the transfer's volume (`report`). Wait `retryAfterMs` between asks. */
    bridgeStatus(ask: BridgeStatusRequest, request?: AgentRequestOptions): Promise<BridgeStatus> {
      checkHash(ask.txHash, "txHash");
      if (!integerIn(ask.chainId, 1, Number.MAX_SAFE_INTEGER)) invalid("chainId is the chain the transaction was sent on.");
      return post("/v1/bridge/status", ask, request);
    },
    /** `POST /v1/report`: counts a sent build's volume toward the key's tier once its receipt matches the build. Report the last step's hash; `pending` means ask again shortly. */
    report(ask: Readonly<{ buildId: string; txHash: Hash }>, request?: AgentRequestOptions): Promise<ReportResult> {
      checkHash(ask.txHash, "txHash");
      if (typeof ask.buildId !== "string" || !ask.buildId) invalid("buildId is the build's id.");
      return post("/v1/report", { buildId: ask.buildId, txHash: ask.txHash }, request);
    },
    /** `GET /v1/openapi.json`: the API's OpenAPI 3.1 description (no key needed). */
    openApi: (request?: AgentRequestOptions) => get<Readonly<Record<string, unknown>>>("/v1/openapi.json", request, undefined, false),
  };
}
export type OxleyAgentClient = ReturnType<typeof createOxleyAgentClient>;

/** Signs the key message with `signer` and has a key issued to its address. Keep the key secret: it is shown once, and only its hash is stored. */
export async function requestAgentApiKey(options: Readonly<{ signer: AgentKeySigner; now?: number }> & Omit<AgentClientOptions, "apiKey">, request?: AgentRequestOptions): Promise<AgentKeyIssued> {
  const { signer, now, ...client } = options, ask = prepareAgentKeyRequest(signer.address, now);
  const signature = await signer.signMessage({ message: ask.message });
  return createOxleyAgentClient(client).issueKey({ address: ask.address, issuedAt: ask.issuedAt, signature }, request);
}

/** The MCP server entry for an MCP client's settings (`mcpServers.oxley`): Streamable HTTP at `/mcp` with the key. */
export function agentMcpServer(apiKey: string, baseUrl = OXLEY_AGENT_API_URL): Readonly<{ type: "http"; url: string; headers: Readonly<{ Authorization: string }> }> {
  if (!KEY.test(apiKey)) throw new AgentApiError("INVALID_CLIENT_OPTIONS", 0, "apiKey is an oxk_ key.");
  return { type: "http", url: new URL("mcp", rootOf(baseUrl)).toString(), headers: { Authorization: `Bearer ${apiKey}` } };
}

/**
 * Local checks of a build's steps before any is signed: at least one step, each a well-formed transaction from `account` on one chain (`chainId` when given), the last one the
 * build's own transaction. It does not prove the calldata is safe; the API checks routers, approvals, recipients and minimums before it answers.
 */
export function checkAgentSteps(steps: readonly AgentStep[], expected: Readonly<{ account: Address; chainId?: number }>): readonly AgentStep[] {
  const fail = (reason: string): never => { throw new AgentApiError("UNEXPECTED_STEPS", 0, reason); };
  if (!Array.isArray(steps) || steps.length === 0) fail("The build has no steps.");
  const chainId = expected.chainId ?? steps[0]!.tx?.chainId;
  steps.forEach((step, index) => {
    const tx = step?.tx;
    if (!tx || !ADDRESS.test(String(tx.to)) || !HEX.test(String(tx.data)) || !DECIMAL.test(String(tx.value)) || (tx.gas != null && !DECIMAL.test(String(tx.gas))))
      fail(`Step ${index + 1} is not a well-formed transaction.`);
    if (String(tx.from).toLowerCase() !== expected.account.toLowerCase()) fail(`Step ${index + 1} is not from ${expected.account}.`);
    if (tx.chainId !== chainId) fail(`Step ${index + 1} is for chain ${tx.chainId}, not ${chainId}.`);
  });
  if (steps.at(-1)!.kind !== "transaction") fail("The last step is not the build's transaction.");
  return steps;
}
/** A step as a viem transaction request (`walletClient.sendTransaction({ account, ...agentTransaction(step) })`): bigint value and gas. */
export function agentTransaction(step: AgentStep): Readonly<{ chainId: number; to: Address; data: `0x${string}`; value: bigint; gas?: bigint }> {
  const { chainId, to, data, value, gas } = step.tx;
  return { chainId, to, data, value: BigInt(value), ...gas == null ? {} : { gas: BigInt(gas) } };
}
