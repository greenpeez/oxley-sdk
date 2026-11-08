import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionResult, zeroAddress, type Hex } from "viem";
import { OxleyError } from "../src/index.js";
import { buildClaimBondRefund, buildClaimCreatorFees } from "../src/launch.js";
import { addr, full, id32 } from "./support/chain.js";
import { ACCOUNT, BENEFICIARY, BOND_WEI, EXECUTOR, FEE_ROUTER, GAS_PRICE, createLaunchWorld, draftSalt, owner, scheduledTerms, type LaunchWorld } from "./support/launch.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const refuses = (promise: Promise<unknown>, expected: string) => assert.rejects(promise, code(expected));
const accountAbi = full("creator-account");
const decode = (data: Hex) => { const { functionName, args } = decodeFunctionData({ abi: accountAbi, data }); return [functionName, ...(args ?? []).map(arg => typeof arg === "string" ? arg.toLowerCase() : arg)]; };
const result = (functionName: "claimBondRefund" | "claimFees", value: boolean | bigint) => encodeFunctionResult({ abi: accountAbi, functionName, result: value } as never);
const sim = (chain: LaunchWorld) => chain.state.simulations as unknown as { to: string; data: Hex; account: string; value?: bigint }[];
const NOW = 1_800_000_000, UNLOCK = NOW + 30 * 86_400;
const funded = (complete: boolean, balance = BOND_WEI) => [balance, 0n, 0n, 0n, 2, true, complete, addr(70)] as const;
/** A launched account whose auction succeeded: fees active with a 30 day lock that has `unlockAt` still to run. */
function launched(patch: NonNullable<Parameters<LaunchWorld["makeAccount"]>[0]> = {}, unlockAt = UNLOCK) {
  const chain = createLaunchWorld(); chain.state.timestamp = BigInt(NOW); chain.setLaunched(patch);
  chain.launch.fees.config = [ACCOUNT, 2_592_000n, BigInt(unlockAt), true]; chain.launch.escrow.fund = funded(true, 0n);
  return chain;
}

test("the bond refund is built for the creator account: claimBondRefund(recipient), never to the account itself, with no value", () => {
  const claim = buildClaimBondRefund({ chainId: 99801, creatorAccount: ACCOUNT, recipient: BENEFICIARY });
  assert.deepEqual([claim.to, claim.value, decode(claim.data)], [ACCOUNT, 0n, ["claimBondRefund", BENEFICIARY]]);
  const fees = buildClaimCreatorFees({ chainId: 99801, creatorAccount: ACCOUNT, recipient: owner });
  assert.deepEqual([fees.to, fees.value, decode(fees.data)], [ACCOUNT, 0n, ["claimFees", owner]]);
  for (const build of [buildClaimBondRefund, buildClaimCreatorFees]) {
    assert.throws(() => build({ chainId: 99801, creatorAccount: ACCOUNT, recipient: ACCOUNT }), code("INVALID_RECIPIENT"));
    assert.throws(() => build({ chainId: 99801, creatorAccount: ACCOUNT, recipient: addr(0) }), code("INVALID_ADDRESS"));
    assert.throws(() => build({ chainId: 0, creatorAccount: ACCOUNT, recipient: owner }), code("INVALID_CHAIN"));
    assert.throws(() => build({ chainId: 99801, creatorAccount: addr(0), recipient: owner }), code("INVALID_ADDRESS"));
  }
});

test("the unused bond read: what the account and the escrow hold for the original creator, and why it can or cannot be claimed yet", async () => {
  const none = createLaunchWorld(); none.state.timestamp = BigInt(NOW);
  const cases: [string, LaunchWorld, string, boolean, bigint][] = [];
  cases.push(["no account", none, "not-launched", false, 0n]);
  const unlaunched = createLaunchWorld(); unlaunched.launch.account = unlaunched.makeAccount(); cases.push(["unlaunched", unlaunched, "not-launched", false, 0n]);
  const waiting = createLaunchWorld(); waiting.state.timestamp = BigInt(NOW);
  waiting.launch.account = waiting.makeAccount({ scheduledStart: BigInt(NOW + 7_200), scheduledAuction: scheduledTerms }); cases.push(["scheduled", waiting, "scheduled", false, 0n]);
  const processing = launched(); processing.launch.escrow.fund = funded(false); cases.push(["settlement running", processing, "processing", false, 0n]);
  const settled = launched(); cases.push(["settled and paid out", settled, "empty", false, 0n]);
  const paid = launched({ bondRefundBalance: 5n }); cases.push(["settled with a balance", paid, "available", true, 5n]);
  const credit = launched({ bondRefundBalance: 5n }); credit.launch.escrow.credits = 2n; cases.push(["with a deferred credit", credit, "available", true, 7n]);
  const creditOnly = launched(); creditOnly.launch.escrow.credits = 3n; cases.push(["only a credit the escrow could not pay", creditOnly, "available", true, 3n]);
  const refunded = createLaunchWorld(); refunded.state.timestamp = BigInt(NOW + 90_000 + 7_200);
  refunded.launch.account = refunded.makeAccount({ scheduledStart: 0n, bondRefundBalance: BOND_WEI }); cases.push(["a refunded schedule", refunded, "available", true, BOND_WEI]);
  for (const [label, chain, reason, claimable, refundable] of cases) {
    const read = await chain.client(() => NOW).getBondRefund({ owner, draftSalt });
    assert.deepEqual([read.reason, read.claimable, read.refundable], [reason, claimable, refundable], label);
    assert.equal(read.blockNumber, 100n); assert.equal(read.dealId, chain.dealId); assert.ok(read.message.length > 10, label);
  }
  // The split: the account's balance and the escrow's credit, which `claimBondRefund` withdraws first.
  const split = await credit.client(() => NOW).getBondRefund({ owner, draftSalt });
  assert.deepEqual([split.accountBalance, split.escrowCredit, split.bondBeneficiary, split.creatorAccount, split.processing], [5n, 2n, owner, ACCOUNT, false]);
  assert.deepEqual(split.escrow, { balance: 0n, funded: true, complete: true, outcome: "successful" });
  // A balance already received is claimable while later settlement can still return more.
  const both = launched({ bondRefundBalance: 5n }); both.launch.escrow.fund = funded(false);
  const early = await both.client(() => NOW).getBondRefund({ owner, draftSalt });
  assert.deepEqual([early.reason, early.claimable, early.processing, early.refundable], ["available", true, true, 5n]); assert.match(early.message, /more returns when settlement completes/);
  // Only the original creator: any other claimant is told so, and a handover of the account does not move the bond.
  assert.equal((await paid.client(() => NOW).getBondRefund({ owner, draftSalt, claimant: EXECUTOR })).reason, "not-beneficiary");
  const handed = launched({ bondRefundBalance: 5n, controller: addr(77), beneficiary: addr(78) });
  const afterHandover = await handed.client(() => NOW).getBondRefund({ owner, draftSalt });
  assert.deepEqual([afterHandover.reason, afterHandover.bondBeneficiary], ["available", owner]);
  await refuses(paid.client(() => NOW).getBondRefund({ owner, draftSalt, claimant: addr(0) }), "INVALID_ADDRESS");
  // The identity is the account's: another creator or beneficiary is not this account.
  await refuses(createLaunchWorld().client().getBondRefund({ owner: addr(0), draftSalt }), "INVALID_ADDRESS");
  await refuses(unlaunched.client(() => NOW).getBondRefund({ owner, draftSalt, beneficiary: BENEFICIARY }), "CREATOR_BINDING_MISMATCH");
});
test("the bond refund claim is the original creator's call, simulated from the creator, paying the refundable bond to the recipient they name", async () => {
  const chain = launched({ bondRefundBalance: 5n }); chain.launch.escrow.credits = 2n; chain.launch.callData = result("claimBondRefund", true);
  const client = chain.client(() => NOW), claim = await client.prepareBondRefundClaim({ owner, draftSalt });
  assert.deepEqual([claim.stage, claim.stages, claim.owner, claim.recipient, claim.expectedAmount, claim.creatorAccount, claim.simulated], ["claim-bond", ["claim-bond"], owner, owner, 7n, ACCOUNT, true]);
  assert.deepEqual([claim.transaction.to, claim.transaction.value, decode(claim.transaction.data)], [ACCOUNT, 0n, ["claimBondRefund", owner]]);
  assert.deepEqual([sim(chain)[0]!.account, sim(chain)[0]!.to, sim(chain)[0]!.value, claim.bond.reason], [owner, ACCOUNT, 0n, "available"]);
  assert.deepEqual([claim.gasEstimate, claim.estimatedGasCost, claim.gasPrice], [3_000_000n, 3_600_000n * GAS_PRICE, GAS_PRICE]);
  // Another recipient for the refund; the account itself and the zero address are not recipients.
  const other = await client.prepareBondRefundClaim({ owner, draftSalt, recipient: BENEFICIARY });
  assert.deepEqual([other.recipient, decode(other.transaction.data)], [BENEFICIARY, ["claimBondRefund", BENEFICIARY]]);
  await refuses(client.prepareBondRefundClaim({ owner, draftSalt, recipient: ACCOUNT }), "INVALID_RECIPIENT");
  await refuses(client.prepareBondRefundClaim({ owner, draftSalt, recipient: addr(0) }), "INVALID_ADDRESS");
  // A recipient that cannot take the bounded native payment leaves the balance in place: the call returns false, which is not a claim.
  chain.launch.callData = result("claimBondRefund", false); await refuses(client.prepareBondRefundClaim({ owner, draftSalt }), "BOND_PAYMENT_REJECTED");
  chain.launch.callData = "0x"; await refuses(client.prepareBondRefundClaim({ owner, draftSalt }), "BOND_PAYMENT_REJECTED");
  chain.launch.callData = result("claimBondRefund", true);
  // The creator pays the gas, in native HYPE; a pending transaction or a moved nonce stops it.
  chain.launch.nativeBalance = 3_600_000n * GAS_PRICE - 1n; await refuses(client.prepareBondRefundClaim({ owner, draftSalt }), "INSUFFICIENT_GAS");
  chain.launch.nativeBalance = 3_600_000n * GAS_PRICE; assert.equal((await client.prepareBondRefundClaim({ owner, draftSalt })).stage, "claim-bond");
  chain.launch.nativeBalance = 2n * 10n ** 18n; chain.launch.pending = 8; await refuses(client.prepareBondRefundClaim({ owner, draftSalt }), "PENDING_TRANSACTION");
  const moved = launched({ bondRefundBalance: 5n }); moved.launch.nonceAfter = 8; moved.launch.callData = result("claimBondRefund", true);
  await refuses(moved.client(() => NOW).prepareBondRefundClaim({ owner, draftSalt }), "NONCE_CHANGED");
  // Why not: nothing to claim, or not yet.
  const refusals: [string, string, (chain: LaunchWorld) => void][] = [
    ["NOTHING_TO_CLAIM", "empty", () => undefined], ["NOTHING_TO_CLAIM", "not-launched", c => { c.launch.account = null; }],
    ["BOND_NOT_CLAIMABLE", "processing", c => { c.launch.escrow.fund = funded(false); }],
    ["BOND_NOT_CLAIMABLE", "scheduled", c => { c.launch.account = c.makeAccount({ scheduledStart: BigInt(NOW + 7_200), scheduledAuction: scheduledTerms }); }],
  ];
  for (const [expected, reason, change] of refusals) {
    const world = launched(); change(world);
    await assert.rejects(world.client(() => NOW).prepareBondRefundClaim({ owner, draftSalt }), (error: unknown) => error instanceof OxleyError && error.code === expected && error.details?.reason === reason);
    assert.equal(world.state.simulations.length, 0, reason);
  }
  // A simulation that the account refuses is surfaced with the step.
  const refused = launched({ bondRefundBalance: 5n }); refused.world.callError = new Error("execution reverted");
  await assert.rejects(refused.client(() => NOW).prepareBondRefundClaim({ owner, draftSalt }), (error: unknown) => error instanceof OxleyError && error.code === "SIMULATION_FAILED" && error.details?.stage === "claim-bond");
});

const feeWorld = (fees: Partial<LaunchWorld["launch"]["fees"]>, patch: NonNullable<Parameters<LaunchWorld["makeAccount"]>[0]> = {}, unlockAt = UNLOCK) => {
  const chain = launched(patch, unlockAt); Object.assign(chain.launch.fees, fees); return chain;
};
test("creator fees read: the ledger and the lock for the recipient, the fee router bound to the pinned curve and bid router, and why a claim is or is not open", async () => {
  const open = (extra: Partial<LaunchWorld["launch"]["fees"]>) => feeWorld({ pending: 1_250_000n, credited: 1_000_000n, claimable: 250_000n, ...extra }, {}, NOW - 10);
  const cases: [string, LaunchWorld, string, boolean][] = [
    ["available", open({}), "available", true], ["locked", feeWorld({ pending: 9n }), "locked", false],
    ["the lock ends this second", feeWorld({ pending: 9n }, {}, NOW), "available", true],
    ["inactive", (() => { const c = open({}); c.launch.fees.config = [ACCOUNT, 0n, 0n, false]; return c; })(), "inactive", false],
    ["empty", open({ pending: 0n, credited: 0n, claimable: 0n }), "empty", false],
  ];
  const unlaunched = createLaunchWorld(); unlaunched.launch.account = unlaunched.makeAccount(); cases.push(["not launched", unlaunched, "not-launched", false]);
  const none = createLaunchWorld(); cases.push(["no account", none, "not-launched", false]);
  for (const [label, chain, reason, claimable] of cases) {
    chain.state.timestamp = BigInt(NOW);
    const read = await chain.client(() => NOW).getCreatorFees({ owner, draftSalt });
    assert.deepEqual([read.reason, read.claimable], [reason, claimable], label); assert.ok(read.message.length > 10);
  }
  const read = await open({}).client(() => NOW).getCreatorFees({ owner, draftSalt });
  assert.deepEqual([read.creatorAccount, read.beneficiary, read.recipient, read.pending, read.credited, read.uncheckpointed, read.routerClaimable, read.unlockAt, read.active, read.quoteAsset],
    [ACCOUNT, owner, owner, 1_250_000n, 1_000_000n, 250_000n, 250_000n, NOW - 10, true, addr(3)]);
  const locked = await feeWorld({ pending: 9n }).client(() => NOW).getCreatorFees({ owner, draftSalt });
  assert.deepEqual([locked.unlockAt, locked.reason], [UNLOCK, "locked"]);
  // The recipient: the account's beneficiary by default (which a launch may have set to another wallet), and a previous beneficiary's credit after a handover.
  const named = open({}); named.launch.account = named.makeAccount({ launched: true, coin: addr(51), beneficiary: BENEFICIARY });
  assert.equal((await named.client(() => NOW).getCreatorFees({ owner, draftSalt, beneficiary: BENEFICIARY })).recipient, BENEFICIARY);
  const stranger = await open({ credited: 0n }).client(() => NOW).getCreatorFees({ owner, draftSalt, recipient: EXECUTOR });
  assert.deepEqual([stranger.recipient, stranger.reason, stranger.claimable], [EXECUTOR, "not-beneficiary", false]);
  const former = open({ credited: 400_000n, pending: 400_000n }), credit = await former.client(() => NOW).getCreatorFees({ owner, draftSalt, recipient: EXECUTOR });
  assert.deepEqual([credit.reason, credit.claimable, credit.pending, credit.uncheckpointed], ["available", true, 400_000n, 0n]);
  // The router is the one the pinned curve and bid router report to, and the deal it names is this account's.
  for (const patch of [{ curveRouter: addr(99) }, { bidRouter: addr(99) }]) await refuses(open(patch).client(() => NOW).getCreatorFees({ owner, draftSalt }), "CREATOR_BINDING_MISMATCH");
  const stolen = open({}); stolen.launch.fees.config = [addr(77), 0n, 0n, true]; await refuses(stolen.client(() => NOW).getCreatorFees({ owner, draftSalt }), "LAUNCH_BINDING_MISMATCH");
  await refuses(open({}).client(() => NOW).getCreatorFees({ owner, draftSalt, recipient: addr(0) }), "INVALID_ADDRESS");
  assert.ok(FEE_ROUTER);
});
test("the creator fee claim is claimFees(recipient), simulated from any caller, paying exactly what was read and refused while the lock or the auction says no", async () => {
  const chain = feeWorld({ pending: 1_250_000n, credited: 1_000_000n, claimable: 250_000n }, {}, NOW - 10); chain.launch.callData = result("claimFees", 1_250_000n);
  const client = chain.client(() => NOW), claim = await client.prepareCreatorFeeClaim({ owner, draftSalt });
  assert.deepEqual([claim.stage, claim.stages, claim.caller, claim.recipient, claim.expectedAmount, claim.creatorAccount, claim.simulated], ["claim-fees", ["claim-fees"], owner, owner, 1_250_000n, ACCOUNT, true]);
  assert.deepEqual([claim.transaction.to, claim.transaction.value, decode(claim.transaction.data)], [ACCOUNT, 0n, ["claimFees", owner]]);
  assert.deepEqual([sim(chain)[0]!.account, sim(chain)[0]!.to, claim.fees.reason, claim.fees.pending], [owner, ACCOUNT, "available", 1_250_000n]);
  // Anyone may deliver the fees, but only to the recorded recipient: another caller pays the gas, the recipient is unchanged.
  const other = await client.prepareCreatorFeeClaim({ owner, draftSalt, caller: EXECUTOR });
  assert.deepEqual([other.caller, other.recipient, other.owner, sim(chain).at(-1)!.account, decode(other.transaction.data)], [EXECUTOR, owner, owner, EXECUTOR, ["claimFees", owner]]);
  await refuses(client.prepareCreatorFeeClaim({ owner, draftSalt, caller: addr(0) }), "INVALID_ADDRESS");
  await refuses(client.prepareCreatorFeeClaim({ owner, draftSalt, recipient: ACCOUNT }), "INVALID_RECIPIENT");
  // The amount the chain would pay must be the amount read.
  chain.launch.callData = result("claimFees", 1_249_999n); await refuses(client.prepareCreatorFeeClaim({ owner, draftSalt }), "FEES_CHANGED");
  chain.launch.callData = "0x"; await refuses(client.prepareCreatorFeeClaim({ owner, draftSalt }), "FEES_CHANGED");
  chain.launch.callData = result("claimFees", 1_250_000n);
  chain.launch.nativeBalance = 3_600_000n * GAS_PRICE - 1n; await refuses(client.prepareCreatorFeeClaim({ owner, draftSalt }), "INSUFFICIENT_GAS");
  // The previous beneficiary's credit is claimed by naming them, from whoever pays.
  const former = feeWorld({ pending: 400_000n, credited: 400_000n }, {}, NOW - 10); former.launch.callData = result("claimFees", 400_000n);
  const credited = await former.client(() => NOW).prepareCreatorFeeClaim({ owner, draftSalt, recipient: EXECUTOR, caller: owner });
  assert.deepEqual([credited.recipient, decode(credited.transaction.data)], [EXECUTOR, ["claimFees", EXECUTOR]]);
  const refusals: [string, string, (chain: LaunchWorld) => void][] = [
    ["CREATOR_FEES_LOCKED", "locked", c => { c.launch.fees.config = [ACCOUNT, 0n, BigInt(NOW + 1), true]; }],
    ["CREATOR_FEES_INACTIVE", "inactive", c => { c.launch.fees.config = [ACCOUNT, 0n, 0n, false]; }],
    ["NOTHING_TO_CLAIM", "empty", c => { c.launch.fees.pending = 0n; c.launch.fees.credited = 0n; }],
    ["NOT_LAUNCHED", "not-launched", c => { c.launch.account = null; }],
    ["NOT_BENEFICIARY", "not-beneficiary", c => { c.launch.fees.credited = 0n; }],
  ];
  for (const [expected, reason, change] of refusals) {
    const world = feeWorld({ pending: 9n, credited: 9n }, {}, NOW - 10); change(world);
    await assert.rejects(world.client(() => NOW).prepareCreatorFeeClaim({ owner, draftSalt, ...reason === "not-beneficiary" ? { recipient: EXECUTOR } : {} }),
      (error: unknown) => error instanceof OxleyError && error.code === expected && error.details?.reason === reason, reason);
    assert.equal(world.state.simulations.length, 0, reason);
  }
  await assert.rejects(feeWorld({ pending: 9n }).client(() => NOW).prepareCreatorFeeClaim({ owner, draftSalt }), (error: unknown) => error instanceof OxleyError && error.code === "CREATOR_FEES_LOCKED" && error.details?.unlockAt === UNLOCK);
  void id32; void zeroAddress;
});
