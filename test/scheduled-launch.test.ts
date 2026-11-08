import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, type Hex } from "viem";
import { OxleyError, tokenAbi, decodeOxleyRevert } from "../src/index.js";
import { oxleyRevertAbi } from "../src/abis.js";
import { buildClaimScheduledFee, buildExecuteScheduledLaunch, buildRefundScheduledLaunch, buildScheduleAuctionLaunch, scheduledPhase, scheduleStartBounds, tickerCooldownEnd,
  tickerKey, validateScheduleStart, SCHEDULED_EXECUTION_GAS_CAP, type createOxleyLaunchClient } from "../src/launch.js";
import { addr, full, id32 } from "./support/chain.js";
import { ACCOUNT, BOND_WEI, EXECUTOR, FEE, GAS_PRICE, createLaunchWorld, draftSalt, intent, noTerms, owner, scheduledTerms, type LaunchWorld } from "./support/launch.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const refuses = (promise: Promise<unknown>, expected: string) => assert.rejects(promise, code(expected));
const accountAbi = full("creator-account");
const decode = (data: Hex) => { const { functionName, args } = decodeFunctionData({ abi: accountAbi, data }); return [functionName, ...args ?? []]; };
type Client = ReturnType<typeof createOxleyLaunchClient>;
type Scheduling = Awaited<ReturnType<Client["prepareScheduledLaunch"]>>;
const SCHEDULE_STAGES = ["terms", "setup", "reset", "approve", "schedule"];
type Step = Extract<Scheduling, { stage: "terms" | "setup" | "reset" | "approve" | "schedule" }>;
/** A step toward the schedule: not complete and not routed, so there is a transaction to sign. */
const sstep = async (prepared: Promise<Scheduling>) => {
  const result = await prepared;
  assert.ok(SCHEDULE_STAGES.includes(result.stage), result.stage);
  return result as Step & { transaction: NonNullable<Step["transaction"]> };
};
type Routed = { scheduled: Extract<Scheduling, { stage: "scheduled" }>; execute: Extract<Scheduling, { stage: "execute" }>; refund: Extract<Scheduling, { stage: "refund" }> };
const routed = async <S extends keyof Routed>(prepared: Promise<unknown>, stage: S): Promise<Routed[S]> => {
  const result = await prepared as Routed[S];
  assert.equal((result as { stage: string }).stage, stage); return result;
};

const NOW = 1_800_000_000, START = NOW + 7_200, WINDOW = 86_400;
const input = { ...intent, startTime: START };
const hold = (until: number) => [ACCOUNT, BigInt(until)] as const;
/** A chain whose head is at `time`, with an account that scheduled a launch for START and holds its ticker until the window closes. */
function scheduled(time: number, patch: NonNullable<Parameters<LaunchWorld["makeAccount"]>[0]> = {}) {
  const chain = createLaunchWorld();
  chain.launch.account = chain.makeAccount({ scheduledStart: BigInt(START), scheduledAuction: scheduledTerms, ...patch });
  chain.launch.hold = hold(START + WINDOW); chain.state.timestamp = BigInt(time);
  return chain;
}
/** An account ready to schedule: the fee is approved to it and the chain's head is at NOW. */
function ready(patch: NonNullable<Parameters<LaunchWorld["makeAccount"]>[0]> = {}) {
  const chain = createLaunchWorld(); chain.launch.account = chain.makeAccount(patch); chain.world.allowance = FEE; chain.state.timestamp = BigInt(NOW);
  return chain;
}
const sim = (chain: LaunchWorld) => chain.state.simulations as unknown as { to: string; data: Hex; account: string; value?: bigint; gasPrice?: bigint; gas?: bigint }[];

test("the calldata of the scheduled-launch calls is the compiled account's own: the schedule carries the bond, execution and refund carry nothing", () => {
  const terms = { chainId: 99801, creatorAccount: ACCOUNT, name: intent.name, symbol: intent.symbol, floorPriceWad: intent.floorPriceWad, creatorLockDays: 30 as const,
    listingCommitmentBps: 5000 as const, auctionDurationHours: 6, durationBlocks: 135_000, startTime: START, bondWei: BOND_WEI, now: NOW };
  const schedule = buildScheduleAuctionLaunch({ ...terms, gasPrice: GAS_PRICE });
  assert.deepEqual([schedule.to, schedule.value, schedule.gasPrice], [ACCOUNT, BOND_WEI, GAS_PRICE]);
  assert.deepEqual(decode(schedule.data), ["scheduleAuctionLaunch", { name: "Example Coin", symbol: "EXAMPLE", floorPrice: intent.floorPriceWad, lockDays: 30, commitmentBps: 5000, requestedHours: 6,
    durationBlocks: 135_000 }, BigInt(START)]);
  assert.equal("gasPrice" in buildScheduleAuctionLaunch(terms), false);
  for (const [build, name] of [[buildExecuteScheduledLaunch, "executeScheduledLaunch"], [buildRefundScheduledLaunch, "refundScheduledLaunch"], [buildClaimScheduledFee, "claimScheduledFee"]] as const) {
    const transaction = build({ chainId: 99801, creatorAccount: ACCOUNT });
    assert.deepEqual([transaction.to, transaction.value, decode(transaction.data)], [ACCOUNT, 0n, [name]]);
  }
  const execution = buildExecuteScheduledLaunch({ chainId: 99801, creatorAccount: ACCOUNT, gasPrice: 1_000_000_000n, gas: SCHEDULED_EXECUTION_GAS_CAP });
  assert.deepEqual([execution.gasPrice, execution.gas], [1_000_000_000n, 12_000_000n]);
  // The contract's own bounds: 15 minutes to 8 days after the block; the account takes an execution at 1 gwei at most, the escrow repays 12,000,000 gas at most.
  assert.throws(() => buildScheduleAuctionLaunch({ ...terms, startTime: NOW + 899 }), code("LAUNCH_START_TOO_SOON"));
  assert.doesNotThrow(() => buildScheduleAuctionLaunch({ ...terms, startTime: NOW + 900 }));
  assert.doesNotThrow(() => buildScheduleAuctionLaunch({ ...terms, startTime: NOW + 8 * 86_400 }));
  assert.throws(() => buildScheduleAuctionLaunch({ ...terms, startTime: NOW + 8 * 86_400 + 1 }), code("LAUNCH_START_TOO_FAR"));
  for (const startTime of [0, -1, 1.5, Number.NaN, 2 ** 53]) assert.throws(() => buildScheduleAuctionLaunch({ ...terms, startTime }), code("INVALID_START_TIME"), String(startTime));
  assert.throws(() => buildScheduleAuctionLaunch({ ...terms, bondWei: 0n }), code("INVALID_AMOUNT"));
  assert.throws(() => buildScheduleAuctionLaunch({ ...terms, durationBlocks: 72_001 * 6 }), code("INVALID_DURATION_BLOCKS"));
  assert.throws(() => buildScheduleAuctionLaunch({ ...terms, symbol: "oxy" }), code("INVALID_SYMBOL"));
  assert.throws(() => buildScheduleAuctionLaunch({ ...terms, name: "x".repeat(81) }), code("INVALID_NAME"));
  assert.throws(() => buildExecuteScheduledLaunch({ chainId: 99801, creatorAccount: ACCOUNT, gasPrice: 1_000_000_001n }), code("GAS_PRICE_TOO_HIGH"));
  assert.throws(() => buildExecuteScheduledLaunch({ chainId: 99801, creatorAccount: ACCOUNT, gas: 12_000_001n }), code("GAS_LIMIT_TOO_HIGH"));
  assert.throws(() => buildRefundScheduledLaunch({ chainId: 0, creatorAccount: ACCOUNT }), code("INVALID_CHAIN"));
  assert.throws(() => buildExecuteScheduledLaunch({ chainId: 99801, creatorAccount: addr(0) }), code("INVALID_ADDRESS"));
});
test("the rules are the live app's: a start 18 minutes to 7 days 23 hours ahead, the 24 hour window inclusive at both ends, the ticker cooldown, and the phase of every state", () => {
  assert.deepEqual(scheduleStartBounds(NOW), { earliest: NOW + 1_080, latest: NOW + 8 * 86_400 - 3_600 });
  assert.doesNotThrow(() => validateScheduleStart(NOW + 1_080, NOW)); assert.doesNotThrow(() => validateScheduleStart(NOW + 8 * 86_400 - 3_600, NOW));
  assert.throws(() => validateScheduleStart(NOW + 1_079, NOW), code("LAUNCH_START_TOO_SOON")); assert.throws(() => validateScheduleStart(NOW + 8 * 86_400 - 3_599, NOW), code("LAUNCH_START_TOO_FAR"));
  assert.throws(() => validateScheduleStart("soon", NOW), code("INVALID_START_TIME"));
  const state = (patch: object) => ({ launched: false, scheduledStart: BigInt(START), bondRefundable: 0n, ...patch });
  const phases = [[START - 1, "pending"], [START, "executable"], [START + WINDOW, "executable"], [START + WINDOW + 1, "expired"]] as const;
  for (const [time, phase] of phases) assert.equal(scheduledPhase(state({}), time), phase, String(time));
  // A launch that ran its schedule keeps `scheduledStart` (the account never clears it); an immediate launch has none; a refund clears it and leaves the bond to claim.
  assert.equal(scheduledPhase(state({ launched: true }), START + 5), "executed"); assert.equal(scheduledPhase(state({ launched: true, scheduledStart: 0n }), START), "none");
  assert.equal(scheduledPhase(state({ scheduledStart: 0n, bondRefundable: 1n }), START), "refunded"); assert.equal(scheduledPhase(state({ scheduledStart: 0n }), START), "none");
  assert.equal(tickerKey("example"), tickerKey("EXAMPLE"));
  assert.equal(tickerCooldownEnd(NOW - 3_600, NOW), Math.ceil((NOW - 3_600 + 259_201) / 60) * 60);
  assert.equal(tickerCooldownEnd(NOW - 259_200, NOW), Math.ceil((NOW + 1) / 60) * 60); assert.equal(tickerCooldownEnd(NOW - 259_201, NOW), undefined);
  assert.equal(tickerCooldownEnd(NOW + 10, NOW), undefined); assert.equal(tickerCooldownEnd(0, NOW), undefined);
});

test("a launch is scheduled one verified, simulated step at a time: setup, approval, then the schedule with the bond as value; the fee approval is the immediate launch's", async () => {
  const chain = createLaunchWorld(); chain.state.timestamp = BigInt(NOW);
  const client = chain.client(() => NOW);
  const setup = await sstep(client.prepareScheduledLaunch(input));
  assert.deepEqual([setup.stage, setup.stages, setup.transaction.value, setup.creatorAccount, setup.simulated], ["setup", ["setup", "approve", "schedule"], 0n, null, true]);
  chain.launch.account = chain.makeAccount();
  const approve = await sstep(client.prepareScheduledLaunch(input));
  assert.deepEqual([approve.stage, approve.stages, approve.transaction.to, approve.transaction.value], ["approve", ["approve", "schedule"], chain.roles.quote, 0n]);
  assert.deepEqual(decodeFunctionData({ abi: tokenAbi, data: approve.transaction.data }).args, [ACCOUNT, FEE]);
  chain.world.allowance = 1n;
  assert.deepEqual((await sstep(client.prepareScheduledLaunch(input))).stages, ["reset", "approve", "schedule"]);
  chain.world.allowance = FEE;
  const schedule = await sstep(client.prepareScheduledLaunch(input));
  assert.deepEqual([schedule.stage, schedule.stages, schedule.durationBlocks], ["schedule", ["schedule"], 22_500]);
  assert.deepEqual([schedule.transaction.to, schedule.transaction.value, schedule.transaction.gasPrice], [ACCOUNT, BOND_WEI, GAS_PRICE]);
  assert.deepEqual(decode(schedule.transaction.data), ["scheduleAuctionLaunch", { name: "Example Coin", symbol: "EXAMPLE", floorPrice: intent.floorPriceWad, lockDays: 30, commitmentBps: 5000,
    requestedHours: 1, durationBlocks: 22_500 }, BigInt(START)]);
  assert.deepEqual((schedule as unknown as { plan: unknown }).plan, { startTime: START, executionWindowEndsAt: START + WINDOW, tickerHeldUntil: START + WINDOW, cancellable: false });
  const last = sim(chain).at(-1)!;
  assert.deepEqual([last.to, last.account, last.value, last.gasPrice, last.data], [ACCOUNT, owner, BOND_WEI, GAS_PRICE, schedule.transaction.data]);
  assert.deepEqual(chain.launch.estimates.at(-1), { to: ACCOUNT, data: schedule.transaction.data, value: BOND_WEI, account: owner, blockNumber: 100n, gasPrice: GAS_PRICE });
  assert.equal(schedule.estimatedGasCost, (3_000_000n * GAS_PRICE * 120n + 99n) / 100n); assert.equal(schedule.deployerBondWei, BOND_WEI);
  // The same identity as an immediate launch: one account, one deal id, so a schedule and a launch exclude each other.
  assert.equal(schedule.dealId, (await client.prepareLaunch(intent).then(step => step.dealId)));
  // Terms first when the registry enforces them; the account and the hold are verified at the observation block.
  chain.launch.terms = { required: 2n, latest: 2n, accepted: 1n, hash: id32(0x7e), uri: "ipfs://terms" };
  assert.deepEqual((await sstep(client.prepareScheduledLaunch(input))).stages, ["terms", "schedule"]);
});
test("a start the contract or the app's margins would refuse is refused before anything is simulated, and a malformed one before any chain read", async () => {
  const chain = createLaunchWorld(), client = chain.client(() => NOW);
  for (const startTime of [0, 1.5, Number.NaN, -3]) await refuses(client.prepareScheduledLaunch({ ...intent, startTime }), "INVALID_START_TIME");
  await refuses(client.prepareScheduledLaunch({ ...intent, startTime: "tomorrow" as never }), "INVALID_START_TIME");
  await refuses(client.prepareScheduledLaunch({ ...intent, startTime: START, symbol: "oxy" }), "INVALID_SYMBOL");
  await refuses(client.prepareScheduledLaunch(undefined as never), "INVALID_LAUNCH");
  assert.equal(chain.state.calls.length + chain.state.simulations.length, 0);
  chain.state.timestamp = BigInt(NOW);
  const bounds: [string, number][] = [["LAUNCH_START_TOO_SOON", NOW + 1_079], ["LAUNCH_START_TOO_SOON", NOW - 5], ["LAUNCH_START_TOO_FAR", NOW + 8 * 86_400],
    ["LAUNCH_START_TOO_FAR", NOW + 8 * 86_400 - 3_599]];
  for (const [expected, startTime] of bounds) await refuses(client.prepareScheduledLaunch({ ...intent, startTime }), expected);
  assert.equal(chain.state.simulations.length, 0);
  assert.equal((await client.prepareScheduledLaunch({ ...intent, startTime: NOW + 1_080 })).stage, "setup");
  assert.equal((await client.prepareScheduledLaunch({ ...intent, startTime: NOW + 8 * 86_400 - 3_600 })).stage, "setup");
});
test("scheduling is refused where the contract would refuse it: a held or cooling ticker, other scheduling rules, a dear gas price, a short wallet", async () => {
  const checks: [string, (chain: LaunchWorld) => void][] = [
    ["TICKER_UNAVAILABLE", chain => { chain.launch.tickerAvailable = false; }],
    ["TICKER_COOLDOWN", chain => { chain.launch.hold = hold(NOW - 3_600); }], ["TICKER_COOLDOWN", chain => { chain.launch.hold = hold(NOW - 259_200); }],
    ["SCHEDULE_RULES_MISMATCH", chain => { chain.launch.holdCooldown = 86_400n; }],
    ["LAUNCH_PAUSED", chain => { chain.launch.paused = true; }], ["LAUNCH_PAUSED", chain => { chain.launch.enabled = false; }],
    ["INSUFFICIENT_BOND", chain => { chain.launch.nativeBalance = BOND_WEI - 1n; }], ["INSUFFICIENT_QUOTE", chain => { chain.world.balance = FEE - 1n; }],
    ["PENDING_TRANSACTION", chain => { chain.launch.pending = 8; }], ["DEAL_ID_USED", chain => { chain.launch.deal = { ...chain.launch.deal, creator: addr(77) }; }],
  ];
  for (const [expected, change] of checks) {
    for (const chain of [createLaunchWorld(), ready()]) {
      chain.state.timestamp = BigInt(NOW); change(chain);
      await refuses(chain.client(() => NOW).prepareScheduledLaunch(input), expected);
    }
  }
  // A hold that lapsed more than three days ago, or is not yet cooling, does not block; an immediate launch ignores the cooldown (the hold rules are for scheduling only).
  const old = createLaunchWorld(); old.state.timestamp = BigInt(NOW); old.launch.hold = hold(NOW - 259_201);
  assert.equal((await old.client(() => NOW).prepareScheduledLaunch(input)).stage, "setup");
  const cooling = createLaunchWorld(); cooling.state.timestamp = BigInt(NOW); cooling.launch.hold = hold(NOW - 3_600);
  assert.equal((await cooling.client(() => NOW).prepareLaunch(intent)).stage, "setup");
  await assert.rejects(cooling.client(() => NOW).prepareScheduledLaunch(input), (error: unknown) => error instanceof OxleyError && error.code === "TICKER_COOLDOWN"
    && error.details?.scheduleFrom === Math.ceil((NOW - 3_600 + 259_201) / 60) * 60);
  // The account's own constants are the ones this SDK mirrors; once the account exists a different bond, lead, window, name limit or gas limit is refused.
  for (const patch of [{ SCHEDULED_BOND: BOND_WEI + 1n }, { MIN_LEAD: 600n }, { MAX_LEAD: 600_000n }, { EXECUTION_WINDOW: 43_200n }, { MAX_NAME_BYTES: 100n }, { MAX_SIMULATED_GAS: 12_000_000n }]) {
    await refuses(ready(patch).client(() => NOW).prepareScheduledLaunch(input), "SCHEDULE_RULES_MISMATCH");
    assert.equal((await ready(patch).client(() => NOW).prepareLaunch(intent)).stage, "launch", "an immediate launch does not read them");
  }
  // The schedule's dry run opens the auction, so the bond escrow's 1 gwei cap applies; the earlier steps are not capped.
  const dear = ready(); dear.launch.gasPrice = 1_000_000_001n;
  await refuses(dear.client(() => NOW).prepareScheduledLaunch(input), "GAS_PRICE_TOO_HIGH");
  const setup = createLaunchWorld(); setup.state.timestamp = BigInt(NOW); setup.launch.gasPrice = 5_000_000_000n;
  assert.equal((await setup.client(() => NOW).prepareScheduledLaunch(input)).stage, "setup");
  const noGas = ready(); noGas.launch.nativeBalance = BOND_WEI + 1n; await refuses(noGas.client(() => NOW).prepareScheduledLaunch(input), "INSUFFICIENT_GAS");
  // A simulation that the account refuses names its step and the contract's rule, never the RPC.
  const refused = ready(); refused.world.callError = Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: accountAbi, errorName: "InvalidConfiguration" }) });
  await assert.rejects(refused.client(() => NOW).prepareScheduledLaunch(input), (error: unknown) => error instanceof OxleyError && error.code === "SIMULATION_FAILED"
    && error.details?.stage === "schedule" && (error.details.accountRevert as { name: string }).name === "InvalidConfiguration" && /account reverted with InvalidConfiguration \(the account is unlaunched/.test(error.message));
  const wrapped = ready(); wrapped.world.callError = Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: accountAbi, errorName: "ScheduledLaunchRefused",
    args: [encodeErrorResult({ abi: full("auction-controller"), errorName: "FloorPriceAboveMaximum", args: [2n * 10n ** 21n, 10n ** 21n] })] }) });
  await assert.rejects(wrapped.client(() => NOW).prepareScheduledLaunch(input), (error: unknown) => error instanceof OxleyError && (error.details?.revert as { name: string }).name === "FloorPriceAboveMaximum");
});

test("getScheduledLaunch reports every phase at the head block's time, with the terms the account stored and the hold on the ticker", async () => {
  const cases: [number, string, boolean, boolean][] = [[START - 1, "pending", false, false], [START, "executable", true, false], [START + WINDOW, "executable", true, false],
    [START + WINDOW + 1, "expired", false, true]];
  for (const [time, phase, executable, refundable] of cases) {
    const chain = scheduled(time), result = await chain.client(() => time).getScheduledLaunch({ owner, draftSalt });
    assert.deepEqual([result.phase, result.executable, result.refundable, result.launched, result.startTime, result.windowEndsAt], [phase, executable, refundable, false, START, START + WINDOW], phase);
    assert.deepEqual(result.terms, { name: "Example Coin", symbol: "EXAMPLE", floorPriceWad: intent.floorPriceWad, creatorLockDays: 30, listingCommitmentBps: 5000, auctionDurationHours: 1, durationBlocks: 22_500 });
    assert.deepEqual([result.creatorAccount, result.heldBondWei, result.tickerHold], [ACCOUNT, BOND_WEI, { holder: ACCOUNT, until: START + WINDOW }]);
    assert.deepEqual([result.secondsUntilStart, result.secondsRemaining], [phase === "pending" ? 1 : null, phase === "executable" ? START + WINDOW - time : null]);
    assert.equal(result.blockNumber, 100n); assert.equal(result.dealId, chain.dealId);
  }
  // Nothing before setup, an account that never scheduled, a launch that ran its schedule (the terms stay readable), an immediate launch, a refund with its bond waiting.
  const none = createLaunchWorld(); none.state.timestamp = BigInt(NOW);
  assert.deepEqual([await none.client(() => NOW).getScheduledLaunch({ owner, draftSalt }).then(r => [r.phase, r.creatorAccount, r.startTime, r.terms])], [["none", null, null, null]]);
  const fresh = ready(); const idle = await fresh.client(() => NOW).getScheduledLaunch({ owner, draftSalt });
  assert.deepEqual([idle.phase, idle.terms, idle.heldBondWei, idle.tickerHold], ["none", null, 0n, null]);
  const ran = scheduled(START + 60); ran.setLaunched({ scheduledStart: BigInt(START), scheduledAuction: scheduledTerms });
  const executed = await ran.client(() => START + 60).getScheduledLaunch({ owner, draftSalt });
  assert.deepEqual([executed.phase, executed.launched, executed.terms?.symbol, executed.heldBondWei, executed.tickerHold], ["executed", true, "EXAMPLE", 0n, null]);
  const direct = createLaunchWorld(); direct.setLaunched(); direct.state.timestamp = BigInt(NOW);
  assert.deepEqual((await direct.client(() => NOW).getScheduledLaunch({ owner, draftSalt })).phase, "none");
  const refunded = createLaunchWorld(); refunded.state.timestamp = BigInt(START + WINDOW + 100);
  refunded.launch.account = refunded.makeAccount({ scheduledStart: 0n, bondRefundBalance: BOND_WEI, scheduledFeeOwed: FEE });
  const after = await refunded.client(() => START + WINDOW + 100).getScheduledLaunch({ owner, draftSalt });
  assert.deepEqual([after.phase, after.bondRefundable, after.feeOwed, after.terms, after.startTime], ["refunded", BOND_WEI, FEE, null, null]);
  // getLaunch carries the schedule's start too.
  const read = await scheduled(START - 10).client().getLaunch({ owner, draftSalt });
  assert.deepEqual([read.scheduled, read.scheduledStart, read.handoverCount], [true, BigInt(START), 0n]);
  await refuses(scheduled(START).client().getScheduledLaunch({ owner: addr(0), draftSalt }), "INVALID_ADDRESS");
  await refuses(scheduled(START).client().getScheduledLaunch({ owner, draftSalt: id32(0) }), "INVALID_HASH");
});

test("prepareLaunch no longer refuses an account with a schedule: it waits before the start, offers the execution in the window and the refund after it", async () => {
  // Before the start there is nothing to send; the step says so and carries the schedule.
  const waiting = scheduled(START - 100), pending = await routed(waiting.client(() => START - 100).prepareLaunch(intent), "scheduled");
  assert.deepEqual([pending.transaction, pending.stages, pending.simulated, pending.launched, pending.schedule.phase, pending.schedule.startTime], [null, [], false, false, "pending", START]);
  assert.equal(waiting.state.simulations.length, 0); assert.equal(waiting.launch.estimates.length, 0);
  assert.equal((await routed(waiting.client(() => START - 100).prepareScheduledLaunch(input), "scheduled")).schedule.secondsUntilStart, 100);
  // The window is the contract's: executable at the start and at its last second, refundable the second after.
  for (const time of [START, START + 5_000, START + WINDOW]) {
    const chain = scheduled(time), run = await routed(chain.client(() => time).prepareLaunch(intent), "execute");
    assert.deepEqual([run.transaction.to, run.transaction.value, decode(run.transaction.data), run.caller, run.owner], [ACCOUNT, 0n, ["executeScheduledLaunch"], owner, owner], String(time));
    assert.deepEqual(chain.state.simulations.map(call => call.account), [owner]);
  }
  const expired = scheduled(START + WINDOW + 1), refund = await routed(expired.client(() => START + WINDOW + 1).prepareLaunch(intent), "refund");
  assert.deepEqual([refund.transaction.to, refund.transaction.value, decode(refund.transaction.data)], [ACCOUNT, 0n, ["refundScheduledLaunch"]]);
  // Pausing stops the execution (it would revert) but never the refund of a launch that missed its window.
  const paused = scheduled(START + 10); paused.launch.paused = true;
  await refuses(paused.client(() => START + 10).prepareLaunch(intent), "LAUNCH_PAUSED");
  const lapsed = scheduled(START + WINDOW + 1); lapsed.launch.paused = true; lapsed.launch.enabled = false;
  assert.equal((await lapsed.client(() => START + WINDOW + 1).prepareLaunch(intent)).stage, "refund");
  // The ticker the account holds reads as taken to everyone else: the route comes first, so a pending schedule is never reported as a taken ticker.
  const held = scheduled(START - 100); held.launch.tickerAvailable = false;
  assert.equal((await held.client(() => START - 100).prepareLaunch(intent)).stage, "scheduled");
  // A launch that ran is complete, as for any launch.
  const ran = scheduled(START + 60); ran.setLaunched({ scheduledStart: BigInt(START), scheduledAuction: scheduledTerms });
  assert.equal((await ran.client(() => START + 60).prepareLaunch(intent)).stage, "complete");
  // After a refund the account is a fresh one: the next step is the fee approval again (the refund returned the fee), then a launch or a new schedule.
  const refunded = createLaunchWorld(); refunded.state.timestamp = BigInt(NOW); refunded.launch.account = refunded.makeAccount({ scheduledStart: 0n, bondRefundBalance: BOND_WEI });
  assert.equal((await refunded.client(() => NOW).prepareLaunch(intent)).stage, "approve"); assert.equal((await refunded.client(() => NOW).prepareScheduledLaunch(input)).stage, "approve");
});

test("executing a due launch: anyone may send it; it is simulated from the caller at 1 gwei at most with a gas limit the bond repays, and refused outside its window", async () => {
  const time = START + 30, chain = scheduled(time), client = chain.client(() => time);
  const run = await routed(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "execute");
  assert.deepEqual([run.stage, run.stages, run.caller, run.owner, run.creatorAccount, run.simulated, run.simulationSkipped, run.reimbursedFromBond], ["execute", ["execute"], owner, owner, ACCOUNT, true, null, true]);
  assert.deepEqual([run.transaction.to, run.transaction.value, decode(run.transaction.data)], [ACCOUNT, 0n, ["executeScheduledLaunch"]]);
  // The step is priced as the account and the escrow require: the network's gas price (at most 1 gwei) and the estimate plus a fifth.
  assert.deepEqual([run.transaction.gasPrice, run.transaction.gas, run.gasPrice, run.gasEstimate, run.gasLimit, run.estimatedGasCost], [GAS_PRICE, 3_600_000n, GAS_PRICE, 3_000_000n, 3_600_000n, 3_600_000n * GAS_PRICE]);
  const call = sim(chain)[0]!;
  assert.deepEqual([call.to, call.account, call.value, call.gasPrice, call.gas], [ACCOUNT, owner, 0n, GAS_PRICE, SCHEDULED_EXECUTION_GAS_CAP]);
  assert.equal(run.schedule.secondsRemaining, WINDOW - 30);
  // Another account executes: it is the one simulated and it pays; the owner is still the creator.
  const other = await routed(client.prepareExecuteScheduledLaunch({ owner, draftSalt, caller: EXECUTOR }), "execute");
  assert.deepEqual([other.caller, other.owner, sim(chain).at(-1)!.account], [EXECUTOR, owner, EXECUTOR]);
  await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt, caller: addr(0) }), "INVALID_ADDRESS");
  // The gas limit is capped at what the escrow repays; an execution that needs more is refused.
  chain.launch.gas = 10_500_000n;
  assert.deepEqual([(await client.prepareExecuteScheduledLaunch({ owner, draftSalt })).transaction.gas], [12_000_000n]);
  chain.launch.gas = 12_000_001n; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "SCHEDULE_EXECUTION_TOO_EXPENSIVE");
  chain.launch.gas = 3_000_000n;
  // The account reverts above 1 gwei, so a dear network is refused rather than priced.
  chain.launch.gasPrice = 1_000_000_000n; assert.equal((await client.prepareExecuteScheduledLaunch({ owner, draftSalt })).transaction.gasPrice, 1_000_000_000n);
  chain.launch.gasPrice = 1_000_000_001n; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "GAS_PRICE_TOO_HIGH");
  chain.launch.gasPrice = GAS_PRICE;
  // The caller pays the gas first (the bond repays it after): its balance must cover the limit.
  chain.launch.nativeBalance = 3_600_000n * GAS_PRICE - 1n; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "INSUFFICIENT_GAS");
  chain.launch.nativeBalance = 3_600_000n * GAS_PRICE; assert.equal((await client.prepareExecuteScheduledLaunch({ owner, draftSalt })).stage, "execute");
  chain.launch.nativeBalance = 2n * 10n ** 18n;
  // The creator must still stand on the current terms; a pause, a pending transaction or a moved nonce stop it too.
  chain.launch.terms = { required: 2n, latest: 2n, accepted: 1n, hash: id32(0x7e), uri: "ipfs://terms" };
  await assert.rejects(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), (error: unknown) => error instanceof OxleyError && error.code === "CREATOR_TERMS_NOT_ACCEPTED");
  chain.launch.terms = { required: 0n, latest: 0n, accepted: 0n, hash: id32(0), uri: "" };
  // The figures the step is priced by are the escrow's: what it repays and the gas price it caps at.
  chain.launch.scheduledLaunchGas = 10_000_000n; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "SCHEDULE_RULES_MISMATCH"); chain.launch.scheduledLaunchGas = 12_000_000n;
  chain.launch.maxGasPrice = 2_000_000_000n; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "SCHEDULE_RULES_MISMATCH"); chain.launch.maxGasPrice = 1_000_000_000n;
  chain.launch.pending = 8; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "PENDING_TRANSACTION"); chain.launch.pending = 7;
  const moved = scheduled(time); moved.launch.nonceAfter = 8; await refuses(moved.client(() => time).prepareExecuteScheduledLaunch({ owner, draftSalt }), "NONCE_CHANGED");
  chain.state.reorg = true; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "REORG");
  // Outside the window or without a schedule, with the contract's own reason.
  const refusals: [string, number, (chain: LaunchWorld) => void][] = [
    ["SCHEDULE_NOT_DUE", START - 1, () => undefined], ["SCHEDULE_WINDOW_CLOSED", START + WINDOW + 1, () => undefined],
    ["ALREADY_LAUNCHED", START + 5, c => c.setLaunched({ scheduledStart: BigInt(START), scheduledAuction: scheduledTerms })],
    ["NOT_SCHEDULED", START + 5, c => { c.launch.account = c.makeAccount(); }], ["NOT_SCHEDULED", START + 5, c => { c.launch.account = null; }],
    ["NOT_SCHEDULED", START + 5, c => { c.launch.account = c.makeAccount({ scheduledStart: 0n, bondRefundBalance: BOND_WEI }); }],
    ["LAUNCH_PAUSED", START + 5, c => { c.launch.paused = true; }],
  ];
  for (const [expected, at, change] of refusals) {
    const world = scheduled(at); change(world);
    await refuses(world.client(() => at).prepareExecuteScheduledLaunch({ owner, draftSalt }), expected);
    assert.equal(world.state.simulations.length, 0, expected);
  }
  // The simulation's own refusal is named, not hidden: the account's generic error carries what it means at this step.
  const reverted = scheduled(time); reverted.world.callError = Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: accountAbi, errorName: "InvalidConfiguration" }) });
  await assert.rejects(reverted.client(() => time).prepareExecuteScheduledLaunch({ owner, draftSalt }), (error: unknown) => error instanceof OxleyError && error.code === "SIMULATION_FAILED"
    && error.details?.stage === "execute" && /the launch must be due/.test(error.message));
  const gas = scheduled(time); gas.launch.estimateError = Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: accountAbi, errorName: "GasPriceTooHigh" }) });
  await assert.rejects(gas.client(() => time).prepareExecuteScheduledLaunch({ owner, draftSalt }), (error: unknown) => error instanceof OxleyError && /gas estimate/.test(error.message));
});
test("on a quiet chain the clock stands in for an old head: a due launch is sent unsimulated at the gas cap, and only when the clock and the head are far apart", async () => {
  // The head is hours before the start (Elysium makes no empty blocks) but the clock is past it by more than the minute of skew.
  const head = START - 5_000, clock = START + 300, chain = scheduled(head), client = chain.client(() => clock);
  const quiet = await routed(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "execute");
  assert.deepEqual([quiet.simulated, quiet.simulationSkipped, quiet.gasEstimate, quiet.transaction.gas, quiet.gasLimit, quiet.schedule.phase, quiet.schedule.chainPhase, quiet.schedule.time.quiet],
    [false, "QUIET_CHAIN_HEAD_BEFORE_START", null, 12_000_000n, 12_000_000n, "executable", "pending", true]);
  assert.equal(chain.state.simulations.length, 0); assert.equal(chain.launch.estimates.length, 0);
  assert.equal((await routed(client.prepareLaunch(intent), "execute")).simulated, false);
  // Inside the skew margin the start is not yet due on the clock, so it is not offered.
  await refuses(chain.client(() => START + 59).prepareExecuteScheduledLaunch({ owner, draftSalt }), "SCHEDULE_NOT_DUE");
  assert.equal((await chain.client(() => START + 60).prepareExecuteScheduledLaunch({ owner, draftSalt })).stage, "execute");
  // The wallet must cover the whole cap when nothing could be estimated.
  chain.launch.nativeBalance = 12_000_000n * GAS_PRICE - 1n; await refuses(client.prepareExecuteScheduledLaunch({ owner, draftSalt }), "INSUFFICIENT_GAS");
  // A live chain's head is the clock: a start the head has not reached is not due, however the device clock reads.
  const live = scheduled(START - 3); await refuses(live.client(() => START + 2).prepareExecuteScheduledLaunch({ owner, draftSalt }), "SCHEDULE_NOT_DUE");
  // When the head already agrees with the clock the step is simulated even on a quiet chain.
  const agreed = scheduled(START + 100), simulated = await agreed.client(() => START + 100 + 5_000).prepareExecuteScheduledLaunch({ owner, draftSalt });
  assert.deepEqual([simulated.simulated, simulated.gasEstimate, simulated.schedule.time.quiet], [true, 3_000_000n, true]);
  assert.equal(agreed.state.simulations.length, 1);
});

test("refunding a launch that did not run: anyone may, strictly after the window; the fee returns to the deployer and the bond becomes claimable", async () => {
  const time = START + WINDOW + 1, chain = scheduled(time), client = chain.client(() => time);
  const refund = await routed(client.prepareRefundScheduledLaunch({ owner, draftSalt }), "refund");
  assert.deepEqual([refund.stage, refund.stages, refund.caller, refund.simulated, refund.simulationSkipped, refund.schedule.phase], ["refund", ["refund"], owner, true, null, "expired"]);
  assert.deepEqual([refund.transaction.to, refund.transaction.value, decode(refund.transaction.data), refund.refunds], [ACCOUNT, 0n, ["refundScheduledLaunch"], { launchFee: FEE, bondWei: BOND_WEI }]);
  assert.deepEqual([refund.gasEstimate, refund.estimatedGasCost], [3_000_000n, 3_600_000n * GAS_PRICE]);
  const call = sim(chain)[0]!; assert.deepEqual([call.to, call.account, call.value], [ACCOUNT, owner, 0n]);
  assert.equal(sim(chain).length, 1);
  // A stranger refunds it, simulated from the stranger.
  const other = await client.prepareRefundScheduledLaunch({ owner, draftSalt, caller: EXECUTOR });
  assert.deepEqual([other.caller, sim(chain).at(-1)!.account], [EXECUTOR, EXECUTOR]);
  // The refund is not offered while the execution still is, with the contract's reason.
  const refusals: [string, number, (chain: LaunchWorld) => void][] = [
    ["SCHEDULE_NOT_EXPIRED", START - 1, () => undefined], ["SCHEDULE_NOT_EXPIRED", START + WINDOW, () => undefined],
    ["ALREADY_LAUNCHED", START + WINDOW + 5, c => c.setLaunched({ scheduledStart: BigInt(START), scheduledAuction: scheduledTerms })],
    ["ALREADY_REFUNDED", START + WINDOW + 5, c => { c.launch.account = c.makeAccount({ scheduledStart: 0n, bondRefundBalance: BOND_WEI }); }],
    ["NOT_SCHEDULED", START + WINDOW + 5, c => { c.launch.account = c.makeAccount(); }], ["NOT_SCHEDULED", START + WINDOW + 5, c => { c.launch.account = null; }],
  ];
  for (const [expected, at, change] of refusals) {
    const world = scheduled(at); change(world);
    await refuses(world.client(() => at).prepareRefundScheduledLaunch({ owner, draftSalt }), expected);
    assert.equal(world.state.simulations.length, 0, expected);
  }
  chain.launch.nativeBalance = 3_600_000n * GAS_PRICE - 1n; await refuses(client.prepareRefundScheduledLaunch({ owner, draftSalt }), "INSUFFICIENT_GAS");
  chain.launch.nativeBalance = 2n * 10n ** 18n;
  chain.launch.pending = 8; await refuses(client.prepareRefundScheduledLaunch({ owner, draftSalt }), "PENDING_TRANSACTION");
  // On a quiet chain whose head is still inside the window, a clock past it offers the refund unsimulated, with a fixed gas limit.
  const head = START + WINDOW - 4_000, clock = START + WINDOW + 300, quiet = scheduled(head);
  const unsimulated = await quiet.client(() => clock).prepareRefundScheduledLaunch({ owner, draftSalt });
  assert.deepEqual([unsimulated.stage, unsimulated.simulated, unsimulated.simulationSkipped, unsimulated.gasEstimate, unsimulated.transaction.gas, quiet.state.simulations.length],
    ["refund", false, "QUIET_CHAIN_HEAD_BEFORE_REFUND_OPENS", null, 500_000n, 0]);
  await refuses(quiet.client(() => START + WINDOW + 59).prepareRefundScheduledLaunch({ owner, draftSalt }), "SCHEDULE_NOT_EXPIRED");
  const reverted = scheduled(time); reverted.world.callError = Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: accountAbi, errorName: "InvalidConfiguration" }) });
  await assert.rejects(reverted.client(() => time).prepareRefundScheduledLaunch({ owner, draftSalt }), (error: unknown) => error instanceof OxleyError && error.details?.stage === "refund"
    && /24 hour window must have closed/.test(error.message));
});
test("a refunded launch fee the deployer could not receive is claimed by anyone, to the deployer only", async () => {
  const chain = createLaunchWorld(); chain.state.timestamp = BigInt(NOW);
  chain.launch.account = chain.makeAccount({ scheduledStart: 0n, bondRefundBalance: BOND_WEI, scheduledFeeOwed: FEE });
  const client = chain.client(() => NOW), claim = await client.prepareClaimScheduledFee({ owner, draftSalt, caller: EXECUTOR });
  assert.deepEqual([claim.stage, claim.stages, claim.caller, claim.recipient, claim.expectedAmount, claim.simulated], ["claim-fee", ["claim-fee"], EXECUTOR, owner, FEE, true]);
  assert.deepEqual([claim.transaction.to, claim.transaction.value, decode(claim.transaction.data), sim(chain)[0]!.account], [ACCOUNT, 0n, ["claimScheduledFee"], EXECUTOR]);
  chain.launch.account = chain.makeAccount({ scheduledStart: 0n, bondRefundBalance: BOND_WEI });
  await refuses(client.prepareClaimScheduledFee({ owner, draftSalt }), "NOTHING_TO_CLAIM");
  chain.launch.account = chain.makeAccount({ scheduledFeeOwed: FEE }); chain.launch.nativeBalance = 1n;
  await refuses(client.prepareClaimScheduledFee({ owner, draftSalt }), "INSUFFICIENT_GAS");
});

test("a scheduled launch's reverts are decoded: the rule the dry run hit, a launch too dear to run, and the claims' own errors", () => {
  const controller = full("auction-controller");
  const inner = encodeErrorResult({ abi: controller, errorName: "TickerUnavailable", args: ["PEPE"] });
  const wrapped = encodeErrorResult({ abi: accountAbi, errorName: "ScheduledLaunchRefused", args: [inner] });
  assert.equal(decodeOxleyRevert(wrapped)?.name, "TickerUnavailable");
  assert.equal(decodeOxleyRevert(encodeErrorResult({ abi: accountAbi, errorName: "ScheduledLaunchRefused", args: [wrapped] }))?.name, "TickerUnavailable");
  // An empty or unknown reason keeps the wrapper's own message.
  for (const reason of ["0x", "0xdeadbeef"] as const) {
    const decoded = decodeOxleyRevert(encodeErrorResult({ abi: accountAbi, errorName: "ScheduledLaunchRefused", args: [reason] }));
    assert.deepEqual([decoded?.name, decoded?.args], ["ScheduledLaunchRefused", [reason]]);
  }
  const expensive = decodeOxleyRevert(encodeErrorResult({ abi: accountAbi, errorName: "ScheduledLaunchTooExpensive", args: [10_000_001n] }));
  assert.deepEqual([expensive?.name, expensive?.args], ["ScheduledLaunchTooExpensive", [10_000_001n]]); assert.match(expensive!.message, /10000001 gas, more than the 10000000/);
  assert.match(decodeOxleyRevert(encodeErrorResult({ abi: accountAbi, errorName: "FeesLocked" }))!.message, /locked until the auction has succeeded/);
  assert.match(decodeOxleyRevert(encodeErrorResult({ abi: accountAbi, errorName: "NotLaunched" }))!.message, /has not launched/);
  assert.ok(oxleyRevertAbi.some(entry => entry.type === "error" && entry.name === "ScheduledLaunchRefused"));
  void encodeAbiParameters;
});
void noTerms;
