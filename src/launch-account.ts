import { zeroAddress, type Address, type Hex } from "viem";
import { registryAbi } from "./abis.js";
import { creatorAccountAbi, creatorAccountFactoryAbi } from "./launch-abis.js";
import { gen2AuctionControllerAbi } from "./gen2-abis.js";
import { address, check, hash, sameAddress } from "./validation.js";
import type { Anchor } from "./types.js";
import type { LaunchContext } from "./launch-context.js";

function checkAccountControl(launched: boolean, current: Address, beneficiary: Address, owner: Address) {
  // A later handover does not undo an already-completed launch or transfer the original bond.
  check(launched || (sameAddress(current, owner) && sameAddress(beneficiary, owner)),
    "CREATOR_BINDING_MISMATCH", "Unlaunched account must retain the requested owner and beneficiary");
}
export function createLaunchReader(context: LaunchContext) {
  const { rpc, deployment, auctions, pins, factory, controller, gen2, canonical, verifyDeployment } = context;
  async function accountAt(owner: Address, dealId: Hex, at: Anchor) {
    const blockNumber = at.blockNumber;
    const account = await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "accountFor", args: [owner, dealId], blockNumber });
    if (sameAddress(account, zeroAddress)) return null;
    address(account);
    const registered = await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "isAccount", args: [account], blockNumber });
    const code = await rpc.getCode({ address: account, blockNumber });
    check(registered && code && code !== "0x", "INVALID_CREATOR_ACCOUNT", "Creator account must be registered by the pinned factory");
    const read = <N extends "controller" | "initialController" | "bondBeneficiary" | "beneficiary" | "dealId" | "auctionController" | "quoteAsset" | "bondEscrow" | "launched" | "coin">(functionName: N) =>
      rpc.readContract({ address: account, abi: creatorAccountAbi, functionName, blockNumber });
    const [current, initial, beneficiary, bondBeneficiary, id, auctionController, quote, bond, launched, coin] = await Promise.all([
      read("controller"), read("initialController"), read("beneficiary"), read("bondBeneficiary"), read("dealId"),
      read("auctionController"), read("quoteAsset"), read("bondEscrow"), read("launched"), read("coin"),
    ]);
    check(sameAddress(initial, owner) && sameAddress(bondBeneficiary, owner) && sameAddress(id, dealId)
      && sameAddress(auctionController, controller) && sameAddress(quote, deployment.quoteToken.address)
      && sameAddress(bond, pins.bondEscrow.address), "CREATOR_BINDING_MISMATCH", "Creator identity or launch contract binding differs");
    checkAccountControl(launched, current, beneficiary, owner);
    return { creatorAccount: account, launched, coin, controller: current, beneficiary, bondBeneficiary };
  }
  async function getLaunch(input: { owner: Address; dealId: Hex }) {
    address(input.owner); hash(input.dealId);
    const at = await verifyDeployment(), state = await accountAt(input.owner, input.dealId, at);
    if (state?.launched) {
      const auction = await auctions.getAuction(input.dealId);
      check(sameAddress(auction.coin, state.coin), "LAUNCH_BINDING_MISMATCH", "Launched account coin does not match auction");
      const deal = await rpc.readContract({ address: deployment.registry.address, abi: registryAbi,
        functionName: "deal", args: [input.dealId], blockNumber: at.blockNumber });
      check(sameAddress(deal.creator, state.creatorAccount), "LAUNCH_BINDING_MISMATCH", "Auction belongs to another creator account");
      const schedule = gen2 ? await scheduleAt(input.dealId, at) : null;
      await canonical(at);
      return { ...at, ...state, dealId: input.dealId, auction: auction.auction, ...(schedule ? { schedule } : {} as { schedule?: never }) };
    }
    await canonical(at);
    return { ...at, ...state, dealId: input.dealId, creatorAccount: state?.creatorAccount ?? null, launched: false as const, auction: null };
  }
  async function scheduleAt(dealId: Hex, at: Anchor) {
    const [requestedHours, durationBlocks, targetEndTimestamp] = await rpc.readContract({ address: controller,
      abi: gen2AuctionControllerAbi, functionName: "schedule", args: [dealId], blockNumber: at.blockNumber });
    check(durationBlocks > 0, "LAUNCH_BINDING_MISMATCH", "Gen2 auction has no recorded schedule");
    return { requestedHours, durationBlocks, targetEndTimestamp };
  }
  return { getLaunch };
}
export type LaunchReader = ReturnType<typeof createLaunchReader>;
export type LaunchState = Awaited<ReturnType<LaunchReader["getLaunch"]>>;
