import { zeroAddress, type Address, type Hex } from "viem";
import { createOxleyLaunchClient, launchDealId, quoteAuctionFloor, type AuctionLaunchInput, type LaunchRpcClient } from "../../src/launch.js";
import { addr, id32, manifest, type ReadCall } from "./chain.js";
import { MAX_FLOOR_PRICE_WAD, MINIMUM_NET_RAISE } from "../../src/controller-rules.js";
import { createAuctionWorld, rolesOf } from "./auction.js";

export const owner = addr(9), draftSalt = id32(0x5a17);
export const ACCOUNT = addr(50), COIN = addr(51), BENEFICIARY = addr(52);
/** The launch contracts of the synthetic manifest: factory 40, entry controller 41, bond escrow 42. */
export const [FACTORY, ENTRY, BOND] = [addr(40), addr(41), addr(42)];
export const FEE = 1_500_000n, BOND_WEI = 500_000_000_000_000_000n, GAS_PRICE = 100_000_000n;
/** A launch: a floor above the minimum raise, a 30 day creator lock, a 50% listing commitment, one hour at 0.16 s per block (22,500 blocks). */
export const intent: AuctionLaunchInput = { owner, draftSalt, name: "Example Coin", symbol: "EXAMPLE", floorPriceWad: 10n ** 20n * 2n, creatorLockDays: 30,
  listingCommitmentBps: 5000, auctionDurationHours: 1, secondsPerBlock: 0.16 };

interface Account { controller: Address; initialController: Address; beneficiary: Address; bondBeneficiary: Address; dealId: Hex; auctionController: Address;
  quoteAsset: Address; bondEscrow: Address; launched: boolean; coin: Address; scheduledStart: bigint; bondRefundBalance: bigint; registered: boolean }
interface Deal { creator: Address; coin: Address; controller: Address; reserveAsset: Address; profile: number; status: number }
const zeroDeal: Deal = { creator: zeroAddress, coin: zeroAddress, controller: zeroAddress, reserveAsset: zeroAddress, profile: 0, status: 0 };

/**
 * The launch graph on top of the auction world: the controller's launch views, the factory, one creator account, the bond escrow, the entry controller and the terms
 * registry, as plain fields a test can change, with the owner's balances, allowance, nonce and the chain's gas price. A new world has no account: the first step is setup.
 */
export function createLaunchWorld(deployment = manifest(), floorCap: bigint | null = MAX_FLOOR_PRICE_WAD, minimumRaise = MINIMUM_NET_RAISE) {
  const auctions = createAuctionWorld(deployment, floorCap, minimumRaise), roles = rolesOf(deployment);
  const dealId = launchDealId({ chainId: deployment.chainId, controller: roles.controller, owner, draftSalt });
  const L = {
    enabled: true, paused: false, fee: FEE, deposit: BOND_WEI, maxGasPrice: 1_000_000_000n, bounds: (hours: number) => [hours * 14_400, hours * 72_000] as const,
    wiring: { controllerFactory: FACTORY as Address, controllerEntry: ENTRY as Address, controllerBond: BOND as Address, factoryController: roles.controller,
      factoryBond: BOND as Address, bondController: roles.controller },
    dealIdFor: undefined as Hex | undefined, tickerAvailable: true, deal: zeroDeal, floor: undefined as readonly [bigint, bigint] | undefined,
    account: null as Account | null, nativeBalance: 2n * 10n ** 18n, pending: 7, latest: 7, nonceAfter: undefined as number | undefined, gasPrice: GAS_PRICE, gas: 3_000_000n,
    estimateError: undefined as Error | undefined, bondHeld: 0n, callData: undefined as Hex | undefined,
    terms: { required: 0n, latest: 0n, accepted: 0n, hash: id32(77), uri: "ipfs://terms" },
    campaign: { open: true, end: 10_000n }, schedule: [1, 22_500, 1_700_000_000n] as readonly [number, number, bigint],
    estimates: [] as { to: Address; data: Hex; value?: bigint; account?: Address; gasPrice?: bigint }[],
  };
  auctions.world.balance = 100_000_000n; auctions.world.allowance = 0n;
  /** A creator account that the factory registered for this creator, with everything it should report. */
  const makeAccount = (patch: Partial<Account> = {}): Account => ({ controller: owner, initialController: owner, beneficiary: owner, bondBeneficiary: owner, dealId,
    auctionController: roles.controller, quoteAsset: roles.quote, bondEscrow: BOND, launched: false, coin: zeroAddress, scheduledStart: 0n, bondRefundBalance: 0n,
    registered: true, ...patch });
  /** The account after a successful launch: the deal is registered to it and the controller has recorded the campaign. */
  const launch = (patch: Partial<Account> = {}) => {
    L.account = makeAccount({ launched: true, coin: COIN, ...patch });
    L.deal = { creator: ACCOUNT, coin: COIN, controller: roles.controller, reserveAsset: roles.quote, profile: 1, status: 1 };
    L.bondHeld = BOND_WEI;
  };
  const handlers: Record<string, (call: ReadCall) => unknown> = {
    [roles.controller.toLowerCase()]: call => ({
      creatorAccountFactory: () => L.wiring.controllerFactory, entryController: () => L.wiring.controllerEntry, bondEscrow: () => L.wiring.controllerBond,
      launchFee: () => L.fee, publicLaunchEnabled: () => L.enabled, isTickerAvailable: () => L.tickerAvailable,
      dealIdFor: () => L.dealIdFor ?? launchDealId({ chainId: deployment.chainId, controller: roles.controller, owner: call.args[0] as Address, draftSalt: call.args[1] as Hex }),
      durationBounds: () => L.bounds(call.args[0] as number), schedule: () => L.schedule,
      campaign: () => [L.account?.launched ? ACCOUNT : zeroAddress, L.account?.launched ? L.account.coin : zeroAddress, L.account?.launched ? dealId : id32(0), L.campaign.end, L.campaign.open],
    } as Record<string, () => unknown>)[call.functionName]?.(),
    [FACTORY.toLowerCase()]: call => ({
      auctionController: () => L.wiring.factoryController, bondEscrow: () => L.wiring.factoryBond,
      accountFor: () => L.account ? ACCOUNT : zeroAddress, isAccount: () => L.account?.registered === true && (call.args[0] as Address).toLowerCase() === ACCOUNT,
    } as Record<string, () => unknown>)[call.functionName]?.(),
    [ENTRY.toLowerCase()]: () => L.paused,
    [BOND.toLowerCase()]: call => ({ controller: () => L.wiring.bondController, CREATOR_DEPOSIT: () => L.deposit, MAX_GAS_PRICE: () => L.maxGasPrice, availableBond: () => L.bondHeld } as Record<string, () => unknown>)[call.functionName]?.(),
    [ACCOUNT.toLowerCase()]: call => {
      const account = L.account;
      if (!account) throw new Error("No account");
      return (account as unknown as Record<string, unknown>)[call.functionName];
    },
    [roles.terms.toLowerCase()]: call => ({
      requiredVersion: () => L.terms.required, latestVersion: () => L.terms.latest, acceptedVersion: () => L.terms.accepted,
      hasAccepted: () => L.terms.required === 0n || L.terms.accepted >= L.terms.required, terms: () => ({ termsHash: L.terms.hash, publishedAt: 5n, uri: L.terms.uri }),
    } as Record<string, () => unknown>)[call.functionName]?.(),
    [roles.registry.toLowerCase()]: () => L.deal,
  };
  // Calls this module owns answer first; anything else (the whole auction graph) is the auction world's.
  const read = async (call: ReadCall & { abi?: unknown }) => {
    const handler = handlers[call.address.toLowerCase()];
    if (call.address.toLowerCase() === roles.adapter.toLowerCase() && call.functionName === "effectiveFloor") {
      const expected = quoteAuctionFloor(call.args[0] as bigint);
      return L.floor ?? [expected.floorPriceQ96, expected.tickSpacingQ96];
    }
    // A function this module has no answer for is the auction graph's.
    const answer = handler ? handler(call) : undefined;
    if (answer !== undefined) return answer;
    return auctions.rpc.readContract(call as never);
  };
  const rpc = { ...auctions.rpc, readContract: read,
    getBalance: async () => L.nativeBalance, getGasPrice: async () => L.gasPrice,
    getTransactionCount: async (p: { blockTag: string }) => {
      if (p.blockTag === "pending") { const value = L.nonceAfter !== undefined && auctions.state.simulations.length > 0 ? L.nonceAfter : L.pending; return value; }
      return L.latest;
    },
    call: async (p: Parameters<typeof auctions.rpc.call>[0]) => { const result = await auctions.rpc.call(p); return L.callData === undefined ? result : { data: L.callData }; },
    estimateGas: async (p: { to: Address; data: Hex; value?: bigint; account?: Address; gasPrice?: bigint }) => {
      L.estimates.push(p);
      if (L.estimateError) throw L.estimateError;
      return L.gas;
    },
  } as unknown as LaunchRpcClient;
  const client = () => createOxleyLaunchClient({ publicClient: rpc, deployment });
  return { ...auctions, rpc, world: auctions.world, launch: L, dealId, roles, client, makeAccount, setLaunched: launch };
}
export type LaunchWorld = ReturnType<typeof createLaunchWorld>;
