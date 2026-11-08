import type { Address, Hex } from "viem";
import { addr, BASE, id32, mockRpc, type ReadCall } from "./chain.js";

const QUOTE = addr(3), ZERO = addr(0);
export const [CURVE, REGISTRY, CONTROLLER, TERMS] = [addr(BASE + 1), addr(BASE + 2), addr(BASE + 4), addr(BASE + 5)];
interface Market { coin: Address; creator: Address; active: boolean }
export interface TermsState { required: bigint; latest: bigint; hash: Hex; uri: string; accepted: Map<string, bigint>; hasAcceptedOverride?: boolean }

function newState() {
  return {
    markets: new Map<string, Market>(),
    open: true, fallbackAt: 1300n, paused: false,
    buy: { out: 900_000n, fee: 20_000n }, sell: { out: 900_000n, fee: 20_000n }, surcharge: 0n,
    balances: new Map<string, bigint>(), allowances: new Map<string, bigint>(),
    terms: { required: 0n, latest: 0n, hash: id32(77), uri: "ipfs://terms", accepted: new Map() } as TermsState,
    curveTerms: TERMS as Address, failures: new Map<string, Error>(),
    quote: QUOTE as Address, quoteDecimals: 6, deal: { profile: 1, status: 3, controller: CONTROLLER as Address },
    logs: [] as { removed: boolean; args: { dealId: Hex } }[], logCalls: 0, logRequests: [] as { address: Address; event: { name: string } }[],
    quoted: [] as { side: string; amount: bigint }[], callError: undefined as Error | undefined,
  };
}
type State = ReturnType<typeof newState>;
const own = (w: State, id: Hex | undefined) => id ? w.markets.get(id.toLowerCase()) : undefined;
function token(w: State, call: ReadCall): unknown {
  const [owner, spender] = call.args as Address[];
  const handlers: Record<string, () => unknown> = {
    decimals: () => call.address === QUOTE ? w.quoteDecimals : 18,
    balanceOf: () => w.balances.get(`${call.address}:${owner}`.toLowerCase()) ?? 2_000_000n,
    allowance: () => w.allowances.get(`${call.address}:${owner}:${spender}`.toLowerCase()) ?? 0n,
  };
  return (handlers[call.functionName] ?? (() => { throw new Error(`Unexpected token read ${call.functionName}`); }))();
}
function curveMarket(w: State, id: Hex | undefined) {
  const market = own(w, id);
  return market ? { coin: market.coin, creator: market.creator, activatedAt: 100n, active: market.active }
    : { coin: ZERO, creator: ZERO, activatedAt: 0n, active: false };
}
function curve(w: State, call: ReadCall): unknown {
  const [id, amount] = call.args as [Hex | undefined, bigint];
  const quoteBuy = () => {
    if (w.paused) throw new Error("BuysPaused");
    w.quoted.push({ side: "buy", amount });
    return [w.buy.out, w.buy.fee];
  };
  const quoteSell = () => { w.quoted.push({ side: "sell", amount }); return [w.sell.out, w.sell.fee]; };
  const handlers: Record<string, () => unknown> = {
    quoteAsset: () => w.quote, termsRegistry: () => w.curveTerms, market: () => curveMarket(w, id), quoteBuy, quoteSell,
    tradingOpen: () => w.open, tradingFallbackAt: () => w.fallbackAt, openingSurchargeWad: () => w.surcharge,
  };
  return (handlers[call.functionName] ?? (() => { throw new Error(`Unexpected curve read ${call.functionName}`); }))();
}
function registry(w: State, call: ReadCall): unknown {
  const market = own(w, call.args[0] as Hex);
  if (call.functionName !== "deal") throw new Error(`Unexpected registry read ${call.functionName}`);
  return market ? { creator: market.creator, coin: market.coin, controller: w.deal.controller, reserveAsset: QUOTE, profile: w.deal.profile, status: w.deal.status }
    : { creator: ZERO, coin: ZERO, controller: ZERO, reserveAsset: ZERO, profile: 0, status: 0 };
}
function terms(w: State, call: ReadCall): unknown {
  const t = w.terms, user = call.args[0] as Address, accepted = t.accepted.get(String(user).toLowerCase()) ?? 0n;
  const handlers: Record<string, () => unknown> = {
    requiredVersion: () => t.required, latestVersion: () => t.latest, acceptedVersion: () => accepted,
    hasAccepted: () => t.hasAcceptedOverride ?? (t.required === 0n || accepted >= t.required),
    terms: () => ({ termsHash: t.hash, publishedAt: 5n, uri: t.uri }),
  };
  return (handlers[call.functionName] ?? (() => { throw new Error(`Unexpected terms read ${call.functionName}`); }))();
}
function readWorld(w: State, call: ReadCall): unknown {
  const failure = w.failures.get(`${call.address.toLowerCase()}:${call.functionName}`);
  if (failure) throw failure;
  if (call.address === QUOTE || (BigInt(call.address) >= 100n && BigInt(call.address) < 200n)) return token(w, call);
  if (call.address === CURVE) return curve(w, call);
  if (call.address === REGISTRY) return registry(w, call);
  if (call.address === TERMS) return terms(w, call);
  throw new Error(`Unexpected read ${call.address} ${call.functionName}`);
}

/** A small model of the curve, registry and terms registry that answers the views the trading client reads. Every knob is a plain field a test can change. */
export function createWorld() {
  const w = newState();
  const coinOf = (n: number) => addr(100 + n);
  function addMarket(n: number, active = true) {
    const id = id32(1000 + n);
    w.markets.set(id.toLowerCase(), { coin: coinOf(n), creator: addr(7), active });
    return { id, coin: coinOf(n) };
  }
  const rpc = mockRpc(call => readWorld(w, call), { onCall: () => { if (w.callError) throw w.callError; }, logs: () => { w.logCalls++; return w.logs; },
    onLogs: request => { w.logRequests.push(request as (typeof w.logRequests)[number]); } });
  return { ...rpc, world: w, addMarket, coinOf };
}
export type World = ReturnType<typeof createWorld>;
