/**
 * The Oxley Agent API's request and answer shapes (its OpenAPI 3.1 file is served at `/v1/openapi.json`). Amounts are decimal strings of base units; addresses are 0x strings.
 * Answers are typed by the fields the API documents; a provider's answer may carry more, which is kept as is.
 */
export type Address = `0x${string}`;
export type Hash = `0x${string}`;

/** A fee added on top of Oxley's, paid straight to `recipient` (whole basis points, from 1 up to the key's tier cap). */
export type AgentIntegratorFee = Readonly<{ recipient: Address; bps: number }>;

/** One unsigned transaction. The agent's own wallet signs and sends it. */
export type AgentTx = Readonly<{ chainId: number; from: Address; to: Address; data: `0x${string}`; value: string; gas?: string }>;
/** One step of a build, sent in the order the steps are returned. An integrator fee transfer is labelled `Integrator fee`. */
export type AgentStep = Readonly<{ kind: "approval" | "transaction"; label: string; tx: AgentTx;
  /** On a bridge approval: what it approves. */
  approval?: Readonly<{ token: Address; spender: Address; amount: string }> }>;

export type AgentKeyRequest = Readonly<{ address: Address; issuedAt: string; signature: `0x${string}` }>;
export type AgentKeyIssued = Readonly<{ key: string; owner: Address; tier: string }>;
/** The limits that apply to a key now. `quotes*` and `builds*` are swap calls; bridge quotes and builds have their own, per minute and per UTC day. */
export type AgentLimits = Readonly<{ quotesPerMinute: number; buildsPerMinute: number; quotesPerDay: number; readsPerMinute: number;
  bridgeQuotesPerMinute: number; bridgeQuotesPerDay: number; bridgeBuildsPerMinute: number; bridgeBuildsPerDay: number; maxIntegratorFeeBps: number }>;
export type AgentStanding = Readonly<{
  owner: Address; tier: string;
  /** All confirmed volume over 30 days, in USD. */
  volume30dUsd: number;
  /** The part that paid Oxley a fee: only this moves the key between tiers, by itself. */
  feePayingVolume30dUsd: number;
  limits: AgentLimits;
  /** Absent on the highest tier. `remainingUsd` is the fee-paying volume still missing. */
  nextTier?: Readonly<{ name: string; minVolumeUsd: number; remainingUsd: number }>;
}>;

export type SwapToken = Readonly<{ address: Address; symbol: string; name: string; decimals: number }>;
export type SwapPriceQuery = Readonly<{ sellToken: Address; buyToken: Address; sellAmount: string; taker?: Address; slippageBps?: number; integratorFee?: AgentIntegratorFee }>;
export type SwapPartnerFee = Readonly<{ recipient: Address; bps: number; amount: string; token: Address; method: "0x" | "transfer" }>;
export type SwapPrice = Readonly<{
  sellToken: Address; buyToken: Address; sellAmount: string;
  /** What arrives, in base units of the buy token, after every fee. */
  buyAmount: string; minBuyAmount?: string; liquidityAvailable?: boolean; sources?: readonly string[];
  /** Oxley's own fee, when one is set: always inside the swap (0x's fee, or on a Nest pool route the swap transaction's own transfer to `recipient`). */
  fee?: Readonly<{ amount: string; bps: number; token: Address; recipient?: Address }>; partnerFee?: SwapPartnerFee;
}> & Readonly<Record<string, unknown>>;
export type SwapQuote = SwapPrice & Readonly<{
  /** `pool` is a swap through Nest's pools. */
  kind?: "swap" | "wrap" | "unwrap" | "pool";
  transaction: Readonly<{ to: Address; data: `0x${string}`; value: string; gas: string | null }>;
  /** Unix seconds after which the build must be made again before sending. */
  expiresAt?: number;
}>;
export type SwapBuildRequest = Readonly<{ sellToken: Address; buyToken: Address; sellAmount: string; taker: Address; slippageBps?: number; integratorFee?: AgentIntegratorFee }>;
export type SwapBuild = Readonly<{ buildId: string; quote: SwapQuote; steps: readonly AgentStep[] }>;
export type ReportOutcome = "counted" | "pending" | "failed" | "mismatch" | "expired" | "duplicate";
export type SwapStatus = Readonly<{ status: "pending" | "success" | "reverted"; report?: ReportOutcome | "unknown" | "invalid" }> & Readonly<Record<string, unknown>>;

export type BridgeChain = Readonly<{ id: number; key: string; name: string; available: boolean; reason: string | null }>;
export type BridgeToken = Readonly<{ chainId: number; address: string; symbol: string; name: string; decimals: number }>;
export type BridgeConfig = Readonly<{ chains: readonly BridgeChain[]; tokens: readonly BridgeToken[]; lanes: readonly unknown[] }> & Readonly<Record<string, unknown>>;
/** A transfer. It starts on an EVM chain; `recipient` is a Solana address when the destination is Solana. */
export type BridgeIntent = Readonly<{
  account: Address; recipient: string; sourceChainId: number; destinationChainId: number; tokenIn: Address; tokenOut: string; amountIn: string;
  slippageBps?: number;
  /** Also deliver a little HYPE for gas on Elysium (USDC into Elysium only). */
  gasTopUp?: boolean;
  integratorFee?: AgentIntegratorFee;
}>;
export type BridgeBuildRequest = BridgeIntent & Readonly<{
  /** The provider that quoted the first leg (`legs[0].quote.provider`), so the build uses the same one. */
  via?: string;
}>;
export type BridgeIntegratorFee = Readonly<{ recipient: Address; bps: number; amount: string; token: string; chainId: number }>;
export type BridgeQuoteView = Readonly<{
  provider: string; sourceChainId: number; destinationChainId: number; tokenIn: string; tokenOut: string; amountIn: string;
  /** What arrives, in base units, after every fee. */
  amountOut: string; minAmountOut?: string; validUntil?: number; etaSeconds?: number | null; fees?: unknown;
}> & Readonly<Record<string, unknown>>;
export type BridgeLegQuote = Readonly<{
  index: number; kind: string; provider: string; chainId: number; destinationChainId: number; status: "quoted" | "indicative" | "unavailable"; reason?: string; quote?: BridgeQuoteView;
}> & Readonly<Record<string, unknown>>;
export type BridgePlan = Readonly<{ ok: boolean; mode: string; legs: readonly unknown[] }> & Readonly<Record<string, unknown>>;
export type BridgeQuote = Readonly<{ plan: BridgePlan; legs: readonly BridgeLegQuote[]; checkedAt: number; integratorFee?: BridgeIntegratorFee }> & Readonly<Record<string, unknown>>;
export type BridgeBuild = Readonly<{
  buildId: string; plan: BridgePlan;
  /** The first leg as prepared: its leg, quote, steps, `simulated` and `expiresAt`. */
  prepared: Readonly<Record<string, unknown>>;
  steps: readonly AgentStep[]; integratorFee?: BridgeIntegratorFee;
}> & Readonly<Record<string, unknown>>;
export type BridgeStatusKind = "bridge" | "relay" | "swap" | "orbit-deposit" | "orbit-withdrawal";
export type BridgeStatusRequest = Readonly<{ chainId: number; txHash: Hash; kind?: BridgeStatusKind; buildId?: string }>;
export type BridgeStatus = Readonly<{
  source: "pending" | "success" | "reverted" | "unknown";
  delivery: Readonly<{ state: "pending" | "inflight" | "delivered" | "failed" | "manual" | "unknown"; phase: string | null; destinationChainId: number | null; destinationTxHash: string | null }> | null;
  stale?: boolean; retryAfterMs?: number; report?: ReportOutcome | "unknown" | "invalid";
}> & Readonly<Record<string, unknown>>;
export type ReportResult = Readonly<{ outcome: ReportOutcome; volume30dUsd: number; feePayingVolume30dUsd: number }>;

export type AgentRequestOptions = Readonly<{ signal?: AbortSignal }>;
