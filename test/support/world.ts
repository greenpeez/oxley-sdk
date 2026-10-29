import type { Address, Hex } from "viem";
import { addr, BASES, id32, mockRpc, type Generation, type ReadCall } from "./chain.js";

export const GENERATIONS: Generation[] = ["flat-fee", "gen3", "gen8"];
const QUOTE = addr(3), ZERO = addr(0);
interface Market { generations: Generation[]; coin: Address; creator: Address; active: boolean }
export interface TermsState { required: bigint; latest: bigint; hash: Hex; uri: string; accepted: Map<string, bigint>; hasAcceptedOverride?: boolean }

function newState() {
  return {
    markets: new Map<string, Market>(),
    open: true, fallbackAt: 1300n, paused: false,
    buy: { out: 900_000n, fee: 20_000n }, sell: { out: 900_000n, fee: 20_000n, collateral: 0n }, surcharge: 0n,
    balances: new Map<string, bigint>(), allowances: new Map<string, bigint>(),
    terms: { required: 0n, latest: 0n, hash: id32(77), uri: "ipfs://terms", accepted: new Map() } as TermsState,
    curveTerms: new Map<Generation, Address>(), failures: new Map<string, Error>(),
    quoteCallers: [] as Address[], quoted: [] as { side: string; amount: bigint }[], callError: undefined as Error | undefined,
  };
}
type State = ReturnType<typeof newState>;
const own = (w: State, generation: Generation, id: Hex | undefined) => {
  const m = id ? w.markets.get(id.toLowerCase()) : undefined;
  return m && m.generations.includes(generation) ? m : undefined;
};
function token(w: State, call: ReadCall): unknown {
  const [owner, spender] = call.args as Address[];
  const handlers: Record<string, () => unknown> = {
    decimals: () => call.address === QUOTE ? 6 : 18,
    balanceOf: () => w.balances.get(`${call.address}:${owner}`.toLowerCase()) ?? 2_000_000n,
    allowance: () => w.allowances.get(`${call.address}:${owner}:${spender}`.toLowerCase()) ?? 0n,
  };
  return (handlers[call.functionName] ?? (() => { throw new Error(`Unexpected token read ${call.functionName}`); }))();
}
function curveMarket(w: State, generation: Generation, id: Hex | undefined) {
  const market = own(w, generation, id), reserve = generation === "gen8" ? {} : { reserveAsset: market ? QUOTE : ZERO };
  return market ? { coin: market.coin, creator: market.creator, activatedAt: 100n, active: market.active, ...reserve }
    : { coin: ZERO, creator: ZERO, activatedAt: 0n, active: false, ...reserve };
}
function curve(w: State, generation: Generation, call: ReadCall): unknown {
  const [id, amount, who] = call.args as [Hex | undefined, bigint, Address];
  const quoteBuy = () => {
    if (w.paused) throw new Error("BuysPaused");
    w.quoted.push({ side: "buy", amount });
    if (generation !== "gen8") w.quoteCallers.push(who);
    return [w.buy.out, w.buy.fee];
  };
  const quoteSell = () => {
    w.quoted.push({ side: "sell", amount });
    if (generation !== "gen8") w.quoteCallers.push(who);
    return generation === "gen8" ? [w.sell.out, w.sell.fee] : [w.sell.out, w.sell.collateral, w.sell.fee];
  };
  const handlers: Record<string, () => unknown> = {
    quoteAsset: () => QUOTE, termsRegistry: () => w.curveTerms.get(generation) ?? addr(BASES[generation] + 5),
    market: () => curveMarket(w, generation, id), quoteBuy, quoteSell,
    tradingOpen: () => w.open, tradingFallbackAt: () => w.fallbackAt, openingSurchargeWad: () => w.surcharge,
  };
  return (handlers[call.functionName] ?? (() => { throw new Error(`Unexpected curve read ${call.functionName}`); }))();
}
function registry(w: State, generation: Generation, call: ReadCall): unknown {
  const market = own(w, generation, call.args[0] as Hex);
  if (call.functionName !== "deal") throw new Error(`Unexpected registry read ${call.functionName}`);
  return market ? { creator: market.creator, coin: market.coin, controller: addr(BASES[generation] + 4), reserveAsset: QUOTE, profile: 1, status: 3 }
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
  for (const generation of GENERATIONS) {
    const base = BASES[generation];
    if (call.address === addr(base + 1)) return curve(w, generation, call);
    if (call.address === addr(base + 2)) return registry(w, generation, call);
    if (call.address === addr(base + 5)) return terms(w, call);
  }
  throw new Error(`Unexpected read ${call.address} ${call.functionName}`);
}

/** A small model of three curves that answers the views the SDK reads. Every knob is a plain field a test can change. */
export function createWorld() {
  const w = newState();
  const coinOf = (n: number) => addr(100 + n);
  function addMarket(generation: Generation | Generation[], n: number, active = true) {
    const id = id32(1000 + n);
    w.markets.set(id.toLowerCase(), { generations: [generation].flat(), coin: coinOf(n), creator: addr(7), active });
    return { id, coin: coinOf(n) };
  }
  const rpc = mockRpc(call => readWorld(w, call), { onCall: () => { if (w.callError) throw w.callError; } });
  return { ...rpc, world: w, addMarket, coinOf };
}
export type World = ReturnType<typeof createWorld>;
