import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionResult } from "viem";
import { OxleyError } from "../src/index.js";
import { addr, full } from "./support/chain.js";
import { ACCOUNT, BENEFICIARY, BOND_WEI, EXECUTOR, createLaunchWorld, draftSalt, owner, scheduledTerms, type LaunchWorld } from "./support/launch.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const refuses = (promise: Promise<unknown>, expected: string) => assert.rejects(promise, code(expected));
const accountAbi = full("creator-account");
const NOW = 1_800_000_000, START = NOW + 7_200, WINDOW = 86_400;
const result = (functionName: "claimBondRefund" | "claimFees", value: boolean | bigint) => encodeFunctionResult({ abi: accountAbi, functionName, result: value } as never);

/** A creator account is found by its address (as an event or the indexed data names it) or by its launched deal, not only by the salt its creator persisted. */
test("a scheduled launch is tended from the account's address alone: anyone reads it, executes it and refunds it without the salt or the owner", async () => {
  const pending = (time: number) => {
    const chain = createLaunchWorld(); chain.state.timestamp = BigInt(time);
    chain.launch.account = chain.makeAccount({ scheduledStart: BigInt(START), scheduledAuction: scheduledTerms }); chain.launch.hold = [ACCOUNT, BigInt(START + WINDOW)];
    return chain;
  };
  const chain = pending(START + 10), client = chain.client(() => START + 10);
  const bySalt = await client.getScheduledLaunch({ owner, draftSalt }), byAccount = await client.getScheduledLaunch({ creatorAccount: ACCOUNT });
  assert.deepEqual([byAccount.phase, byAccount.owner, byAccount.dealId, byAccount.creatorAccount, byAccount.terms], [bySalt.phase, owner, chain.dealId, ACCOUNT, bySalt.terms]);
  // A stranger executes it: simulated from them, while the original creator stays the owner. With no caller named, the creator is the sender.
  const run = await client.prepareExecuteScheduledLaunch({ creatorAccount: ACCOUNT, caller: EXECUTOR });
  assert.deepEqual([run.stage, run.caller, run.owner, run.creatorAccount, (chain.state.simulations.at(-1) as { account: string }).account], ["execute", EXECUTOR, owner, ACCOUNT, EXECUTOR]);
  assert.equal((await client.prepareExecuteScheduledLaunch({ creatorAccount: ACCOUNT })).caller, owner);
  assert.equal((await client.prepareExecuteScheduledLaunch({ creatorAccount: ACCOUNT, owner })).caller, owner);
  const late = pending(START + WINDOW + 5), refund = await late.client(() => START + WINDOW + 5).prepareRefundScheduledLaunch({ creatorAccount: ACCOUNT, caller: EXECUTOR });
  assert.deepEqual([refund.stage, refund.caller, refund.owner], ["refund", EXECUTOR, owner]);
  // The owner, when named, must be the account's creator.
  await refuses(client.getScheduledLaunch({ creatorAccount: ACCOUNT, owner: EXECUTOR }), "CREATOR_BINDING_MISMATCH");
  // Anything that is not the pinned factory's account for its own creator and deal is refused.
  const unregistered = pending(START); unregistered.launch.account = unregistered.makeAccount({ registered: false, scheduledStart: BigInt(START) });
  await refuses(unregistered.client(() => START).getScheduledLaunch({ creatorAccount: ACCOUNT }), "INVALID_CREATOR_ACCOUNT");
  const elsewhere = pending(START); elsewhere.launch.recorded = addr(77);
  await refuses(elsewhere.client(() => START).getScheduledLaunch({ creatorAccount: ACCOUNT }), "INVALID_CREATOR_ACCOUNT");
  for (const patch of [{ auctionController: addr(77) }, { quoteAsset: addr(77) }, { bondEscrow: addr(77) }, { bondBeneficiary: addr(77) }]) {
    const other = pending(START); other.launch.account = other.makeAccount({ scheduledStart: BigInt(START), ...patch });
    await refuses(other.client(() => START).getScheduledLaunch({ creatorAccount: ACCOUNT }), "CREATOR_BINDING_MISMATCH");
  }
  await refuses(client.getScheduledLaunch({ creatorAccount: addr(0) }), "INVALID_ADDRESS");
  await refuses(client.getScheduledLaunch({ creatorAccount: ACCOUNT, owner: addr(0) }), "INVALID_ADDRESS");
  await refuses(client.prepareExecuteScheduledLaunch({ creatorAccount: ACCOUNT, caller: addr(0) }), "INVALID_ADDRESS");
  await refuses(client.getScheduledLaunch(undefined as never), "INVALID_LAUNCH");
});
test("a launched deal is named by its id, as the market is: the registry's creator is the account, and an unlaunched or foreign deal has none", async () => {
  const chain = createLaunchWorld(); chain.state.timestamp = BigInt(NOW); chain.setLaunched(); chain.launch.escrow.credits = 3n;
  const client = chain.client(() => NOW), dealId = chain.dealId;
  const bond = await client.getBondRefund({ dealId });
  assert.deepEqual([bond.creatorAccount, bond.owner, bond.dealId, bond.reason, bond.refundable, bond.bondBeneficiary], [ACCOUNT, owner, dealId, "available", 3n, owner]);
  assert.equal((await client.getBondRefund({ dealId: dealId.toUpperCase().replace("0X", "0x") as never })).dealId, dealId);
  assert.equal((await client.getLaunch({ dealId })).launch?.coin, chain.launch.account!.coin);
  // The wallet named as the owner is the claimant; another wallet is not the original creator.
  assert.equal((await client.getBondRefund({ dealId, owner })).reason, "available");
  await refuses(client.getBondRefund({ dealId, owner: EXECUTOR }), "CREATOR_BINDING_MISMATCH");
  assert.equal((await client.getBondRefund({ dealId, claimant: EXECUTOR })).reason, "not-beneficiary");
  chain.launch.callData = result("claimBondRefund", true);
  const claim = await client.prepareBondRefundClaim({ dealId });
  assert.deepEqual([claim.owner, claim.recipient, claim.expectedAmount, (chain.state.simulations.at(-1) as { account: string }).account], [owner, owner, 3n, owner]);
  assert.equal((await client.prepareBondRefundClaim({ creatorAccount: ACCOUNT, recipient: BENEFICIARY })).recipient, BENEFICIARY);
  // Fees by deal: the fee ledger and the router's lock, with anyone paying the gas.
  chain.launch.fees.config = [ACCOUNT, 2_592_000n, BigInt(NOW - 5), true]; chain.launch.fees.pending = 40n; chain.launch.fees.credited = 40n;
  const fees = await client.getCreatorFees({ dealId });
  assert.deepEqual([fees.reason, fees.pending, fees.recipient, fees.owner, fees.creatorAccount], ["available", 40n, owner, owner, ACCOUNT]);
  chain.launch.callData = result("claimFees", 40n);
  const feeClaim = await client.prepareCreatorFeeClaim({ dealId, caller: EXECUTOR });
  assert.deepEqual([feeClaim.caller, feeClaim.owner, feeClaim.recipient, (chain.state.simulations.at(-1) as { account: string }).account], [EXECUTOR, owner, owner, EXECUTOR]);
  assert.equal((await client.prepareCreatorFeeClaim({ dealId })).caller, owner);
  // A deal that was never launched has no account, and a deal another controller opened is not this release's.
  const unlaunched = createLaunchWorld(); unlaunched.state.timestamp = BigInt(NOW);
  const none = await unlaunched.client(() => NOW).getScheduledLaunch({ dealId: unlaunched.dealId });
  assert.deepEqual([none.phase, none.creatorAccount, none.owner], ["none", null, null]);
  await refuses(unlaunched.client(() => NOW).prepareExecuteScheduledLaunch({ dealId: unlaunched.dealId }), "NOT_SCHEDULED");
  await refuses(unlaunched.client(() => NOW).prepareRefundScheduledLaunch({ dealId: unlaunched.dealId }), "NOT_SCHEDULED");
  await refuses(unlaunched.client(() => NOW).prepareClaimScheduledFee({ dealId: unlaunched.dealId }), "NOTHING_TO_CLAIM");
  await refuses(unlaunched.client(() => NOW).prepareBondRefundClaim({ dealId: unlaunched.dealId, owner }), "NOTHING_TO_CLAIM");
  await refuses(unlaunched.client(() => NOW).prepareCreatorFeeClaim({ dealId: unlaunched.dealId, owner }), "NOT_LAUNCHED");
  assert.equal((await unlaunched.client(() => NOW).getCreatorFees({ dealId: unlaunched.dealId })).reason, "not-launched");
  const foreign = createLaunchWorld(); foreign.setLaunched(); foreign.launch.deal = { ...foreign.launch.deal, controller: addr(77) };
  await refuses(foreign.client().getBondRefund({ dealId: foreign.dealId }), "LAUNCH_BINDING_MISMATCH");
  await refuses(client.getBondRefund({ dealId: "0x12" as never }), "INVALID_HASH");
  void BOND_WEI;
});
