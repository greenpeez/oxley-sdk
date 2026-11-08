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

export function createLaunchReader(context: LaunchContext) {
  const { rpc, deployment, pins, factory, controller, verifyDeployment, canonical } = context;
  const adapter = deployment.auctionBindings.adapter.address;

  /** The creator account for this identity, or null before setup. An account is accepted only if the pinned factory registered it and it is bound to this creator, deal and graph. */
  async function accountAt(id: LaunchIdentity, dealId: Hex, at: Anchor) {
    const blockNumber = at.blockNumber, beneficiary = id.beneficiary ?? id.owner;
    const derived = await rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "dealIdFor", args: [id.owner, id.draftSalt], blockNumber });
    check(derived.toLowerCase() === dealId.toLowerCase(), "LAUNCH_ID_MISMATCH", "The controller derives a different deal id for this creator and salt");
    const account = await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "accountFor", args: [id.owner, dealId], blockNumber });
    if (sameAddress(account, zeroAddress)) return null;
    address(account);
    const [registered, code] = await Promise.all([
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "isAccount", args: [account], blockNumber }), rpc.getCode({ address: account, blockNumber })]);
    check(registered && code && code !== "0x", "INVALID_CREATOR_ACCOUNT", "The creator account must be registered by the pinned factory");
    const read = <N extends "controller" | "initialController" | "beneficiary" | "bondBeneficiary" | "dealId" | "auctionController" | "quoteAsset" | "bondEscrow" | "launched" | "coin" | "scheduledStart" | "bondRefundBalance">(functionName: N) =>
      rpc.readContract({ address: account, abi: creatorAccountAbi, functionName, blockNumber });
    const [current, initial, accountBeneficiary, bondBeneficiary, accountDeal, auctionController, quote, bond, launched, coin, scheduledStart, bondRefundable] = await Promise.all([
      read("controller"), read("initialController"), read("beneficiary"), read("bondBeneficiary"), read("dealId"), read("auctionController"), read("quoteAsset"),
      read("bondEscrow"), read("launched"), read("coin"), read("scheduledStart"), read("bondRefundBalance")]);
    check(sameAddress(initial, id.owner) && sameAddress(bondBeneficiary, id.owner) && sameAddress(accountDeal, dealId) && sameAddress(auctionController, controller)
      && sameAddress(quote, deployment.quoteToken.address) && sameAddress(bond, pins.bondEscrow.address),
    "CREATOR_BINDING_MISMATCH", "The creator account's identity or launch contract binding differs");
    // A later handover does not undo a completed launch or move the original bond; before launch the account must still be the requested one.
    check(launched || (sameAddress(current, id.owner) && sameAddress(accountBeneficiary, beneficiary)),
      "CREATOR_BINDING_MISMATCH", "An unlaunched account must keep the requested owner and beneficiary");
    return { creatorAccount: account as Address | null, launched, coin: launched ? coin : null, accountController: current as Address | null,
      beneficiary: accountBeneficiary as Address | null, bondBeneficiary: bondBeneficiary as Address | null, scheduled: scheduledStart !== 0n, bondRefundable };
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
  /** The state of one launch at one block, assuming the deployment was verified at that block. */
  async function stateAt(id: LaunchIdentity, at: Anchor) {
    address(id.owner); hash(id.draftSalt); if (id.beneficiary !== undefined) address(id.beneficiary);
    const dealId = launchDealId({ chainId: deployment.chainId, controller, owner: id.owner, draftSalt: id.draftSalt });
    const account = await accountAt(id, dealId, at);
    if (!account) return { dealId, creatorAccount: null, launched: false, coin: null, accountController: null, beneficiary: null, bondBeneficiary: null,
      scheduled: false, bondRefundable: 0n, launch: null };
    const launch = account.coin ? await launchedAt(dealId, account.creatorAccount!, account.coin, at) : null;
    return { dealId, ...account, launch };
  }
  /** Reads the launch back from chain: the creator account if setup happened, and, once launched, the coin, the auction and the recorded schedule and bond. */
  async function getLaunch(id: LaunchIdentity) {
    const { blockNumber, blockHash, timestamp } = await verifyDeployment(), at = { blockNumber, blockHash, timestamp }, state = await stateAt(id, at);
    await canonical(at);
    return { ...at, ...state };
  }
  return { stateAt, getLaunch };
}
export type LaunchReader = ReturnType<typeof createLaunchReader>;
export type LaunchState = Awaited<ReturnType<LaunchReader["stateAt"]>>;
