import { createPublicClient, http, type Address, type Hex } from "viem";
import { testnetDeployment } from "@oxley/sdk";
import { createOxleyLaunchClient, type CreatorRef, type LaunchTransaction, type ScheduledLaunchInput } from "@oxley/sdk/launch";

const launches = createOxleyLaunchClient({
  deployment: testnetDeployment,
  publicClient: createPublicClient({ transport: http("https://testnet-rpc.elysium.kinetiq.xyz") }),
});

/**
 * Schedules a launch: the same steps as an immediate launch, ending in `schedule`, which takes the 1.5 USDC fee (approved to the creator account) and the 0.5 HYPE bond
 * now and holds them, with the ticker, until `input.startTime`. There is no cancel. `send` is the owner's own wallet: it signs and broadcasts the transaction and resolves
 * only once a successful canonical receipt is confirmed; the SDK never signs or sends.
 */
export async function schedule(input: ScheduledLaunchInput, send: (transaction: LaunchTransaction, stage: string) => Promise<void>) {
  for (let steps = 0; steps < 8; steps++) {
    const step = await launches.prepareScheduledLaunch(input);
    if (step.stage === "complete") return step.launch;
    // Scheduled, nothing to send until the start: step.schedule.startTime, step.schedule.secondsUntilStart.
    if (step.stage === "scheduled") return step.schedule;
    // Once the schedule is confirmed the account is routed: the next call returns `execute` in the window and `refund` after it.
    await send(step.transaction, step.stage);
  }
  throw new Error("The schedule did not complete; read it back with getScheduledLaunch before retrying");
}

/**
 * Looks after a scheduled launch from a bot's own wallet. The protocol keeper normally executes it at the start second (the creator's bond repays whoever does, so anyone may);
 * a launch that missed its 24 hour window can be refunded by anyone, and the keeper never refunds it.
 */
export async function tend(identity: CreatorRef, caller: Address, send: (transaction: LaunchTransaction, stage: string) => Promise<Hex | void>) {
  const state = await launches.getScheduledLaunch(identity);
  if (state.executable) {
    // Simulated from `caller`, with the gas price (1 gwei at most) and gas limit the bond escrow repays; `simulated: false` marks a quiet chain whose head predates the start.
    const run = await launches.prepareExecuteScheduledLaunch({ ...identity, caller });
    return send(run.transaction, run.stage);
  }
  if (state.refundable) {
    const refund = await launches.prepareRefundScheduledLaunch({ ...identity, caller });
    return send(refund.transaction, refund.stage);
  }
  return state.phase; // pending (state.secondsUntilStart), executed, refunded or none
}
