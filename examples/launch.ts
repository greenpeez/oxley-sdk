import { createPublicClient, http, parseUnits, type Address, type Hex } from "viem";
import { testnetDeployment } from "@oxley/sdk";
import { createOxleyLaunchClient, newDraftSalt, type AuctionLaunchInput, type LaunchTransaction } from "@oxley/sdk/launch";

const launches = createOxleyLaunchClient({
  deployment: testnetDeployment,
  publicClient: createPublicClient({ transport: http("https://testnet-rpc.elysium.kinetiq.xyz") }),
});

/** The terms of one launch. Persist `draftSalt` with them before the first transaction and reuse both on every retry. */
export const example = (owner: Address, draftSalt: Hex = newDraftSalt()): AuctionLaunchInput => ({
  owner, draftSalt, name: "Example Coin", symbol: "EXAMPLE",
  floorPriceWad: parseUnits("0.00015", 24), // 24 decimals for a human USDC-per-coin price; validated against the $30,000 minimum raise and the cap
  creatorLockDays: 30, listingCommitmentBps: 5000, auctionDurationHours: 6,
});

/**
 * Walks the launch to the end. `send` is the owner's own wallet: it signs and broadcasts `transaction` (a `launch` step carries the 0.5 HYPE bond as `value` and the
 * `gasPrice` it was simulated at) and resolves only once a successful canonical receipt is confirmed. The SDK prepares each step from fresh chain state, so a confirmed step
 * is never repeated; it never signs or sends.
 */
export async function launch(input: AuctionLaunchInput, send: (transaction: LaunchTransaction, stage: string) => Promise<void>) {
  for (let steps = 0; steps < 8; steps++) {
    const step = await launches.prepareLaunch(input);
    if (step.stage === "complete") return step.launch; // { coin, auction, auctionId, endBlock, schedule, bondHeld, ... }
    // Show the owner what is about to be signed: step.stage, step.stages, step.launchFee (USDC), step.deployerBondWei (HYPE), step.estimatedGasCost (HYPE).
    // At step.stage === "terms", show the text at step.terms.uri first. Persist a pending record before sending and the hash right after.
    await send(step.transaction, step.stage);
  }
  throw new Error("The launch did not complete; read it back with getLaunch before retrying");
}
