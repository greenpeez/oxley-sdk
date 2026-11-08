import { createPublicClient, http, type Address } from "viem";
import { testnetDeployment } from "@oxley/sdk";
import { createOxleyLaunchClient, type CreatorRef, type LaunchTransaction } from "@oxley/sdk/launch";

const launches = createOxleyLaunchClient({
  deployment: testnetDeployment,
  publicClient: createPublicClient({ transport: http("https://testnet-rpc.elysium.kinetiq.xyz") }),
});

/**
 * `identity` is `{ dealId }`, `{ creatorAccount }` or `{ owner, draftSalt }`. Claims the unused operating bond (native HYPE) for the original creator wallet. Only `owner` may send it; `recipient` defaults to the owner and must be able to take a plain
 * native payment (the contract forwards 30,000 gas). Returns why nothing was prepared when there is nothing to claim yet.
 */
export async function claimBond(identity: CreatorRef, send: (transaction: LaunchTransaction) => Promise<void>, recipient?: Address) {
  const bond = await launches.getBondRefund(identity);
  if (!bond.claimable) return { claimed: false as const, reason: bond.reason, message: bond.message }; // processing | scheduled | empty | not-launched
  const claim = await launches.prepareBondRefundClaim({ ...identity, ...recipient ? { recipient } : {} });
  await send(claim.transaction); // pays claim.expectedAmount wei to claim.recipient
  return { claimed: true as const, wei: claim.expectedAmount };
}

/**
 * Claims the creator's trading fees (USDC). Anyone may send `claimFees(recipient)`, but it pays only the fees credited to the recipient, which defaults to the account's
 * beneficiary. The claim opens once the auction has succeeded and the creator lock has ended.
 */
export async function claimFees(identity: CreatorRef, send: (transaction: LaunchTransaction) => Promise<void>, caller?: Address) {
  const fees = await launches.getCreatorFees(identity);
  if (!fees.claimable) return { claimed: false as const, reason: fees.reason, unlockAt: fees.unlockAt, message: fees.message }; // locked | inactive | empty | not-launched | not-beneficiary
  const claim = await launches.prepareCreatorFeeClaim({ ...identity, ...caller ? { caller } : {} });
  await send(claim.transaction); // pays claim.expectedAmount USDC base units to claim.recipient
  return { claimed: true as const, units: claim.expectedAmount };
}
