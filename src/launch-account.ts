import { zeroAddress, type Address, type Hex } from "viem";
import { registryAbi } from "./abis.js";
import { auctionAdapterAbi, auctionControllerAbi } from "./auction-abis.js";
import { creatorAccountAbi, creatorAccountFactoryAbi, launchBondAbi, launchControllerAbi } from "./launch-abis.js";
import { launchDealId } from "./launch-input.js";
import { address, check, hash, sameAddress } from "./validation.js";
import type { Anchor } from "./types.js";
import type { LaunchContext } from "./launch-context.js";

/** The identity of one launch: the creator, the persisted salt and the account's fee beneficiary (the creator unless the launch names another). */
export interface LaunchIdentity { owner: Address; draftSalt: Hex; beneficiary?: Address }
/**
 * A creator account named by its address, as an event or the indexed data names it: the account must be the one the pinned factory registered for its own creator and deal. The
 * creator is read from the account; `owner`, when given, must be that creator.
 */
export interface CreatorAccountRef { creatorAccount: Address; owner?: Address }
/** A launched deal named by its id (the market), as the registry knows it: its creator account is the registry's creator. `owner`, when given, must be the account's creator. */
export interface DealRef { dealId: Hex; owner?: Address }
/** Whatever names a creator account: the launch's salt, the account's address, or the launched deal. The reads and claims take any of them; only preparing a launch needs the salt. */
export type CreatorRef = LaunchIdentity | CreatorAccountRef | DealRef;

export function createLaunchReader(context: LaunchContext) {
  const { rpc, deployment, pins, factory, controller, verifyDeployment, canonical } = context;
  const adapter = deployment.auctionBindings.adapter.address;

  /**
   * The creator account of a deal, or null before setup. An account is accepted only if the pinned factory registered it and it is bound to this creator, deal and graph.
   * `expect` is what the caller asserted about it (the creator and, for a launch's own identity, the beneficiary); `known` is an account found by address or registry, which the
   * factory's record of its creator and deal must then confirm.
   */
  async function accountAt(expect: { owner?: Address; beneficiary?: Address }, dealId: Hex, at: Anchor, known?: Address) {
    const blockNumber = at.blockNumber;
    const account = known ?? await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "accountFor", args: [expect.owner!, dealId], blockNumber });
    if (sameAddress(account, zeroAddress)) return null;
    address(account);
    const [registered, code] = await Promise.all([
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "isAccount", args: [account], blockNumber }), rpc.getCode({ address: account, blockNumber })]);
    check(registered && code && code !== "0x", "INVALID_CREATOR_ACCOUNT", "The creator account must be registered by the pinned factory");
    const read = <N extends "controller" | "initialController" | "beneficiary" | "bondBeneficiary" | "dealId" | "auctionController" | "quoteAsset" | "bondEscrow" | "launched" | "coin" | "scheduledStart" | "bondRefundBalance" | "handoverCount">(functionName: N) =>
      rpc.readContract({ address: account, abi: creatorAccountAbi, functionName, blockNumber });
    const [current, initial, accountBeneficiary, bondBeneficiary, accountDeal, auctionController, quote, bond, launched, coin, scheduledStart, bondRefundable, handoverCount] = await Promise.all([
      read("controller"), read("initialController"), read("beneficiary"), read("bondBeneficiary"), read("dealId"), read("auctionController"), read("quoteAsset"),
      read("bondEscrow"), read("launched"), read("coin"), read("scheduledStart"), read("bondRefundBalance"), read("handoverCount")]);
    check((expect.owner === undefined || sameAddress(initial, expect.owner)) && sameAddress(bondBeneficiary, initial) && sameAddress(accountDeal, dealId) && sameAddress(auctionController, controller)
      && sameAddress(quote, deployment.quoteToken.address) && sameAddress(bond, pins.bondEscrow.address),
    "CREATOR_BINDING_MISMATCH", "The creator account's identity or launch contract binding differs");
    // An account found by address or deal must be the one the factory recorded for its own creator and deal.
    if (known) check(sameAddress(await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "accountFor", args: [initial, dealId], blockNumber }), account),
      "INVALID_CREATOR_ACCOUNT", "The creator account must be the one the pinned factory recorded for its creator and deal");
    // A later handover does not undo a completed launch or move the original bond; before launch the account must still be the requested one.
    check(launched || (sameAddress(current, initial) && (expect.beneficiary === undefined || sameAddress(accountBeneficiary, expect.beneficiary))),
      "CREATOR_BINDING_MISMATCH", "An unlaunched account must keep the requested owner and beneficiary");
    return { creatorAccount: account as Address | null, owner: initial as Address | null, launched, coin: launched ? coin : null, accountController: current as Address | null,
      beneficiary: accountBeneficiary as Address | null, bondBeneficiary: bondBeneficiary as Address | null, scheduled: scheduledStart !== 0n, scheduledStart, bondRefundable,
      /** Counts the handovers of the account's controller: the epoch its publication signatures (token details, images) are bound to. */
      handoverCount };
  }
  /** What the chain recorded for a launched account: the coin, the auction, its end block, the exact-duration schedule and the bond. */
  async function launchedAt(dealId: Hex, account: Address, coin: Address, at: Anchor) {
    const blockNumber = at.blockNumber;
    const [campaign, deal, auction, schedule, bondHeld] = await Promise.all([
      rpc.readContract({ address: controller, abi: auctionControllerAbi, functionName: "campaign", args: [dealId], blockNumber }),
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [dealId], blockNumber }),
      rpc.readContract({ address: adapter, abi: auctionAdapterAbi, functionName: "auctionFor", args: [dealId], blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "schedule", args: [dealId], blockNumber }),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "availableBond", args: [dealId, account], blockNumber }),
    ]);
    check(campaign[2].toLowerCase() === dealId.toLowerCase() && sameAddress(campaign[0], account) && sameAddress(campaign[1], coin)
      && sameAddress(deal.creator, account) && sameAddress(deal.coin, coin) && sameAddress(deal.controller, controller) && sameAddress(deal.reserveAsset, deployment.quoteToken.address),
    "LAUNCH_BINDING_MISMATCH", "The launched account does not match the controller's campaign or the registry's deal");
    address(auction);
    return { coin, auction, auctionId: campaign[2], endBlock: campaign[3], open: campaign[4], dealStatus: deal.status,
      schedule: { requestedHours: schedule[0], durationBlocks: schedule[1], targetEndTimestamp: schedule[2] }, bondHeld };
  }
  const noAccount = (dealId: Hex, owner: Address | null) => ({ dealId, creatorAccount: null, owner, launched: false, coin: null, accountController: null, beneficiary: null,
    bondBeneficiary: null, scheduled: false, scheduledStart: 0n, bondRefundable: 0n, handoverCount: 0n, launch: null });
  /** The account a reference names, with the state it reports: by the launch's salt, by the account's address, or by the launched deal. */
  async function accountOf(id: CreatorRef, at: Anchor) {
    const blockNumber = at.blockNumber;
    if (!id || typeof id !== "object") check(false, "INVALID_LAUNCH", "Launch identity required");
    if (id.owner !== undefined) address(id.owner);
    if ("draftSalt" in id) {
      hash(id.draftSalt); if (id.beneficiary !== undefined) address(id.beneficiary);
      const dealId = launchDealId({ chainId: deployment.chainId, controller, owner: id.owner, draftSalt: id.draftSalt });
      const derived = await rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "dealIdFor", args: [id.owner, id.draftSalt], blockNumber });
      check(derived.toLowerCase() === dealId.toLowerCase(), "LAUNCH_ID_MISMATCH", "The controller derives a different deal id for this creator and salt");
      return { dealId, account: await accountAt({ owner: id.owner, beneficiary: id.beneficiary ?? id.owner }, dealId, at), owner: id.owner as Address | null };
    }
    if ("creatorAccount" in id) {
      address(id.creatorAccount);
      const registered = await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "isAccount", args: [id.creatorAccount], blockNumber });
      check(registered, "INVALID_CREATOR_ACCOUNT", "The creator account must be registered by the pinned factory");
      const dealId = await rpc.readContract({ address: id.creatorAccount, abi: creatorAccountAbi, functionName: "dealId", blockNumber });
      return { dealId, account: await accountAt({ owner: id.owner }, dealId, at, id.creatorAccount), owner: id.owner ?? null };
    }
    hash(id.dealId);
    const dealId = id.dealId.toLowerCase() as Hex, deal = await rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [dealId], blockNumber });
    if (sameAddress(deal.creator, zeroAddress)) return { dealId, account: null, owner: id.owner ?? null };
    check(sameAddress(deal.controller, controller), "LAUNCH_BINDING_MISMATCH", "The deal was not opened by this release's launch controller");
    return { dealId, account: await accountAt({ owner: id.owner }, dealId, at, deal.creator), owner: id.owner ?? null };
  }
  /** The state of one launch at one block, assuming the deployment was verified at that block. */
  async function stateAt(id: CreatorRef, at: Anchor) {
    const { dealId, account, owner } = await accountOf(id, at);
    if (!account) return noAccount(dealId, owner);
    const launch = account.coin ? await launchedAt(dealId, account.creatorAccount!, account.coin, at) : null;
    return { dealId, ...account, launch };
  }
  /** Reads the launch back from chain: the creator account if setup happened, and, once launched, the coin, the auction and the recorded schedule and bond. */
  async function getLaunch(id: CreatorRef) {
    const { blockNumber, blockHash, timestamp } = await verifyDeployment(), at = { blockNumber, blockHash, timestamp }, state = await stateAt(id, at);
    await canonical(at);
    return { ...at, ...state };
  }
  return { stateAt, getLaunch };
}
export type LaunchReader = ReturnType<typeof createLaunchReader>;
export type LaunchState = Awaited<ReturnType<LaunchReader["stateAt"]>>;
