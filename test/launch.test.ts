import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, keccak256, toHex, type Hex } from "viem";
import { OxleyError, tokenAbi, parseDeployment } from "../src/index.js";
import { parseLaunchDeployment } from "../src/launch.js";
import { oxleyRevertAbi } from "../src/abis.js";
import { auctionDurationBlocks, auctionDurationBounds, buildAuctionLaunch, buildCreatorAccount, buildLaunchApprovals, launchDealId, newDraftSalt,
  sampleSecondsPerBlock, validateAuctionLaunch, createOxleyLaunchClient, minimumRaiseFloor, MAX_FLOOR_PRICE_WAD, type LaunchStage } from "../src/launch.js";
import { addr, full, id32, manifest } from "./support/chain.js";
import { NET_RAISE_50K, auction } from "./support/auction.js";
import { ACCOUNT, BENEFICIARY, BOND_WEI, COIN, ENTRY, BOND, FACTORY, FEE, GAS_PRICE, createLaunchWorld, draftSalt, intent, owner, type LaunchWorld } from "./support/launch.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const refuses = (promise: Promise<unknown>, expected: string) => assert.rejects(promise, code(expected));
const factoryAbi = full("creator-account-factory"), accountAbi = full("creator-account");
const decode = (abi: ReturnType<typeof full>, data: Hex) => { const { functionName, args } = decodeFunctionData({ abi, data }); return [functionName, ...args ?? []]; };
type Prepared = Awaited<ReturnType<ReturnType<typeof createOxleyLaunchClient>["prepareLaunch"]>>;
/** A prepared step of the immediate launch: not complete, and not routed to a schedule, so there is a transaction to sign. */
const step = async (prepared: Promise<Prepared>) => {
  const result = await prepared;
  assert.ok(["terms", "setup", "reset", "approve", "launch"].includes(result.stage), result.stage);
  return result as Extract<Prepared, { stage: LaunchStage }> & { transaction: NonNullable<Extract<Prepared, { stage: LaunchStage }>["transaction"]> };
};
/** An account that setup created, with the fee already approved to it: the next step is the launch. */
const ready = (patch: NonNullable<Parameters<LaunchWorld["makeAccount"]>[0]> = {}) => {
  const chain = createLaunchWorld();
  chain.launch.account = chain.makeAccount(patch); chain.world.allowance = FEE;
  return chain;
};

test("the calldata of every step is the compiled contracts' own: factory setup, fee approvals to the account, and the exact-duration launch with the bond as value", () => {
  const setup = buildCreatorAccount({ chainId: 99801, factory: FACTORY, draftSalt, beneficiary: BENEFICIARY });
  assert.deepEqual([setup.to, setup.value], [FACTORY, 0n]);
  assert.deepEqual(decode(factoryAbi, setup.data), ["createAccountForDraft", draftSalt, BENEFICIARY]);
  const launch = buildAuctionLaunch({ chainId: 99801, creatorAccount: ACCOUNT, name: intent.name, symbol: intent.symbol, floorPriceWad: intent.floorPriceWad,
    creatorLockDays: 30, listingCommitmentBps: 5000, auctionDurationHours: 6, durationBlocks: 135_000, bondWei: BOND_WEI, gasPrice: GAS_PRICE });
  assert.deepEqual([launch.to, launch.value, launch.gasPrice], [ACCOUNT, BOND_WEI, GAS_PRICE]);
  assert.deepEqual(decode(accountAbi, launch.data), ["launchAuctionWithCommitmentAndExactDuration", "Example Coin", "EXAMPLE", intent.floorPriceWad, 30, 5000, 6, 135_000]);
  assert.equal("gasPrice" in buildAuctionLaunch({ chainId: 99801, creatorAccount: ACCOUNT, ...intent, durationBlocks: 22_500, bondWei: BOND_WEI }), false);
  const approvals = (currentAllowance: bigint) => buildLaunchApprovals({ chainId: 99801, quoteToken: addr(3), creatorAccount: ACCOUNT, launchFee: FEE, currentAllowance });
  assert.equal(approvals(FEE).length, 0); assert.equal(approvals(FEE + 1n).length, 0);
  assert.deepEqual(approvals(0n).map(tx => decode(tokenAbi, tx.data)), [["approve", ACCOUNT, FEE]]);
  assert.deepEqual(approvals(1n).map(tx => decode(tokenAbi, tx.data)), [["approve", ACCOUNT, 0n], ["approve", ACCOUNT, FEE]]);
  assert.ok(approvals(0n).every(tx => tx.to === addr(3) && tx.value === 0n));
});
test("builders refuse malformed input, and the duration bounds are the Gen10 ones: 14,400 to 72,000 blocks an hour", () => {
  const base = { chainId: 99801, creatorAccount: ACCOUNT, ...intent, durationBlocks: 22_500, bondWei: BOND_WEI };
  assert.deepEqual(auctionDurationBounds(1), { minimumBlocks: 14_400, maximumBlocks: 72_000 }); assert.deepEqual(auctionDurationBounds(24), { minimumBlocks: 345_600, maximumBlocks: 1_728_000 });
  assert.doesNotThrow(() => buildAuctionLaunch({ ...base, auctionDurationHours: 24, durationBlocks: 1_728_000 }));
  assert.doesNotThrow(() => buildAuctionLaunch({ ...base, auctionDurationHours: 1, durationBlocks: 72_000 }));
  for (const [hours, blocks] of [[1, 72_001], [1, 14_399], [24, 1_728_001], [2, 14_400], [1, 22_500.5]] as const) {
    assert.throws(() => buildAuctionLaunch({ ...base, auctionDurationHours: hours, durationBlocks: blocks }), code("INVALID_DURATION_BLOCKS"), `${hours} h ${blocks}`);
  }
  for (const hours of [0, 25, 1.5]) assert.throws(() => auctionDurationBounds(hours), code("INVALID_DURATION"));
  assert.throws(() => buildAuctionLaunch({ ...base, chainId: 0 }), code("INVALID_CHAIN"));
  assert.throws(() => buildAuctionLaunch({ ...base, creatorAccount: addr(0) }), code("INVALID_ADDRESS"));
  assert.throws(() => buildAuctionLaunch({ ...base, bondWei: 0n }), code("INVALID_AMOUNT"));
  assert.throws(() => buildAuctionLaunch({ ...base, symbol: "oxy" }), code("INVALID_SYMBOL"));
  assert.throws(() => buildAuctionLaunch({ ...base, floorPriceWad: MAX_FLOOR_PRICE_WAD + 1n }), code("FLOOR_ABOVE_MAXIMUM"));
  assert.throws(() => buildCreatorAccount({ chainId: 99801, factory: FACTORY, draftSalt: id32(0), beneficiary: owner }), code("INVALID_HASH"));
  assert.throws(() => buildCreatorAccount({ chainId: 99801, factory: addr(0), draftSalt, beneficiary: owner }), code("INVALID_ADDRESS"));
  assert.throws(() => buildLaunchApprovals({ chainId: 99801, quoteToken: addr(3), creatorAccount: ACCOUNT, launchFee: 0n, currentAllowance: 0n }), code("INVALID_AMOUNT"));
  assert.equal(auctionDurationBlocks({ hours: 1, secondsPerBlock: 0.16 }), 22_500); assert.equal(auctionDurationBlocks({ hours: 2, secondsPerBlock: 0.05 }), 144_000);
  for (const secondsPerBlock of [0.049, 0.26]) assert.throws(() => auctionDurationBlocks({ hours: 1, secondsPerBlock }), code("INVALID_DURATION_BLOCKS"));
  for (const secondsPerBlock of [0, -1, Number.NaN, Infinity]) assert.throws(() => auctionDurationBlocks({ hours: 1, secondsPerBlock }), code("INVALID_BLOCK_RATE"));
});
test("the deal id is the controller's namespaced id and a draft salt is random, nonzero and 32 bytes", () => {
  // keccak256("OXLEY_AUCTION_LAUNCH_GEN6"): the controller's LAUNCH_NAMESPACE constant, written out here rather than derived (the live check reads it from the controller).
  const namespace = "0x265ed5d0ea8ae47c1971c5643a4c5aabbe305fb04094380952a15d2c460b2ed8" as Hex;
  assert.equal(keccak256(toHex("OXLEY_AUCTION_LAUNCH_GEN6")), namespace);
  const expected = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
    [namespace, 99801n, addr(24), owner, draftSalt]));
  assert.equal(launchDealId({ chainId: 99801, controller: addr(24), owner, draftSalt }), expected);
  assert.notEqual(launchDealId({ chainId: 99801, controller: addr(24), owner: addr(10), draftSalt }), expected);
  assert.notEqual(launchDealId({ chainId: 99802, controller: addr(24), owner, draftSalt }), expected);
  assert.notEqual(launchDealId({ chainId: 99801, controller: addr(25), owner, draftSalt }), expected);
  assert.notEqual(launchDealId({ chainId: 99801, controller: addr(24), owner, draftSalt: id32(2) }), expected);
  const salts = new Set(Array.from({ length: 20 }, newDraftSalt));
  assert.equal(salts.size, 20); for (const salt of salts) { assert.match(salt, /^0x[0-9a-f]{64}$/); assert.notEqual(BigInt(salt), 0n); }
  assert.throws(() => launchDealId({ chainId: 99801, controller: addr(24), owner, draftSalt: id32(0) }), code("INVALID_HASH"));
});

test("input is refused before any chain read: terms, ticker, lock, commitment, duration, salt, and every floor the controller would refuse", async () => {
  const chain = createLaunchWorld(), client = chain.client();
  const bad: [string, Record<string, unknown>][] = [
    ["INVALID_NAME", { name: "" }], ["INVALID_NAME", { name: " padded " }], ["INVALID_NAME", { name: "x".repeat(81) }], ["INVALID_NAME", { name: "\u{1F680}".repeat(21) }],
    ["INVALID_SYMBOL", { symbol: "lower" }], ["INVALID_SYMBOL", { symbol: "TOOLONGSYMBOL" }], ["INVALID_SYMBOL", { symbol: "A-B" }], ["INVALID_SYMBOL", { symbol: "" }],
    ["TICKER_RESERVED", { symbol: "OXY" }], ["INVALID_LOCK", { creatorLockDays: 7 }], ["INVALID_COMMITMENT", { listingCommitmentBps: 2500 }],
    ["INVALID_DURATION", { auctionDurationHours: 0 }], ["INVALID_DURATION", { auctionDurationHours: 25 }], ["INVALID_DURATION", { auctionDurationHours: 1.5 }],
    ["INVALID_DURATION_BLOCKS", { durationBlocks: 72_001 }], ["INVALID_BLOCK_RATE", { secondsPerBlock: 0 }], ["INVALID_HASH", { draftSalt: id32(0) }],
    ["INVALID_ADDRESS", { owner: addr(0) }], ["INVALID_ADDRESS", { beneficiary: addr(0) }], ["INVALID_NAME", { name: undefined }],
    // The floor rules: above the 1e21 cap, below the lowest floor that can raise the $30,000 minimum, and below the curve's own minimum.
    ["FLOOR_ABOVE_MAXIMUM", { floorPriceWad: MAX_FLOOR_PRICE_WAD + 1n }], ["FLOOR_BELOW_MINIMUM_RAISE", { floorPriceWad: minimumRaiseFloor() - 1n }],
    ["INVALID_FLOOR", { floorPriceWad: 9_000_000_000_000_000_000n }], ["INVALID_AMOUNT", { floorPriceWad: 0n }],
  ];
  for (const [expected, patch] of bad) {
    const input = { ...intent, ...patch } as typeof intent;
    assert.throws(() => validateAuctionLaunch(input), code(expected), `${expected} ${JSON.stringify(patch, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    await refuses(client.prepareLaunch(input), expected);
  }
  assert.throws(() => validateAuctionLaunch(undefined as never), code("INVALID_LAUNCH")); await refuses(client.prepareLaunch(undefined as never), "INVALID_LAUNCH");
  assert.equal(chain.state.calls.length, 0); assert.equal(chain.state.simulations.length, 0);
  // The lowest accepted floor and the cap itself pass.
  for (const floorPriceWad of [minimumRaiseFloor(), MAX_FLOOR_PRICE_WAD]) assert.doesNotThrow(() => validateAuctionLaunch({ ...intent, floorPriceWad }));
});
test("a controller that does not enforce the $30,000 minimum raise or the floor cap cannot prepare a launch", async () => {
  const fifty = createLaunchWorld(manifest(), MAX_FLOOR_PRICE_WAD, NET_RAISE_50K);
  await refuses(fifty.client().prepareLaunch(intent), "AUCTION_BINDING_MISMATCH");
  // An uncapped controller has no `MAX_FLOOR_PRICE_WAD` getter: the read fails and nothing is simulated.
  const uncapped = createLaunchWorld(manifest(), null);
  await assert.rejects(uncapped.client().prepareLaunch(intent));
  assert.equal(fifty.state.simulations.length + uncapped.state.simulations.length, 0);
});

test("verification pins the launch contracts by runtime code and their bindings, fee, bond and duration bounds, and returns the costs", async () => {
  const chain = createLaunchWorld(), verified = await chain.client().verifyDeployment();
  assert.deepEqual([verified.launchFee, verified.deployerBondWei, verified.maxLaunchGasPrice, verified.publicLaunchEnabled, verified.entriesPaused],
    [FEE, BOND_WEI, 1_000_000_000n, true, false]);
  assert.equal(verified.blockNumber, 100n);
  // Every launch pin is read for its code at the observation block.
  for (const pin of [FACTORY, ENTRY, BOND]) {
    const changed = createLaunchWorld(); changed.state.codes.set(pin, "0x6001");
    await refuses(changed.client().verifyDeployment(), "CODE_MISMATCH"); await refuses(changed.client().prepareLaunch(intent), "CODE_MISMATCH");
    assert.equal(changed.state.simulations.length, 0);
  }
  // The auction graph is verified too: a changed hook is as fatal as a changed factory.
  const hook = createLaunchWorld(); hook.state.codes.set(hook.roles.hook, "0x6001");
  await refuses(hook.client().prepareLaunch(intent), "CODE_MISMATCH");
  const wirings = ["controllerFactory", "controllerEntry", "controllerBond", "factoryController", "factoryBond", "bondController"] as const;
  for (const wiring of wirings) {
    const chain = createLaunchWorld(); chain.launch.wiring[wiring] = addr(99);
    await refuses(chain.client().verifyDeployment(), "LAUNCH_BINDING_MISMATCH");
  }
  for (const patch of [{ fee: FEE + 1n }, { deposit: BOND_WEI + 1n }] as const) {
    const chain = createLaunchWorld(); Object.assign(chain.launch, patch);
    await refuses(chain.client().verifyDeployment(), "LAUNCH_COST_MISMATCH");
  }
  // Gen2 to Gen8 stop at 36,000 blocks an hour: a controller with that ceiling would revert a long launch, so it is refused up front.
  const old = createLaunchWorld(); old.launch.bounds = hours => [hours * 14_400, hours * 36_000];
  await refuses(old.client().verifyDeployment(), "DURATION_BOUNDS_MISMATCH");
  const elsewhere = createLaunchWorld(); elsewhere.state.chainId = 1;
  await refuses(elsewhere.client().verifyDeployment(), "CHAIN_MISMATCH");
  const forked = createLaunchWorld(); forked.state.reorg = true;
  await refuses(forked.client().verifyDeployment(), "REORG");
});

test("a launch is prepared one verified, simulated step at a time: setup, approval, launch, then the launch read back", async () => {
  const chain = createLaunchWorld(), client = chain.client();
  const setup = await step(client.prepareLaunch(intent));
  assert.deepEqual([setup.stage, setup.stages, setup.creatorAccount, setup.simulated, setup.launched], ["setup", ["setup", "approve", "launch"], null, true, false]);
  assert.deepEqual([setup.transaction.to, setup.transaction.value, setup.transaction.chainId], [FACTORY, 0n, 31337]);
  assert.deepEqual(decode(factoryAbi, setup.transaction.data), ["createAccountForDraft", draftSalt, owner]);
  assert.equal(setup.dealId, launchDealId({ chainId: 31337, controller: chain.roles.controller, owner, draftSalt }));
  assert.deepEqual(chain.state.simulations.map(call => [call.to, call.account]), [[FACTORY, owner]]);
  assert.equal(chain.state.simulations[0]!.data, setup.transaction.data);
  assert.equal("gasPrice" in setup.transaction, false);

  chain.launch.account = chain.makeAccount();
  const approve = await step(client.prepareLaunch(intent));
  assert.deepEqual([approve.stage, approve.stages, approve.creatorAccount], ["approve", ["approve", "launch"], ACCOUNT]);
  assert.deepEqual([approve.transaction.to, approve.transaction.value], [chain.roles.quote, 0n]);
  assert.deepEqual(decode(tokenAbi, approve.transaction.data), ["approve", ACCOUNT, FEE]);

  chain.world.allowance = 1n;
  const reset = await step(client.prepareLaunch(intent));
  assert.deepEqual([reset.stage, reset.stages], ["reset", ["reset", "approve", "launch"]]);
  assert.deepEqual(decode(tokenAbi, reset.transaction.data), ["approve", ACCOUNT, 0n]);

  chain.world.allowance = FEE;
  const launch = await step(client.prepareLaunch(intent));
  assert.deepEqual([launch.stage, launch.stages, launch.durationBlocks, launch.secondsPerBlock, launch.rateSample], ["launch", ["launch"], 22_500, 0.16, null]);
  assert.deepEqual([launch.transaction.to, launch.transaction.value, launch.transaction.gasPrice], [ACCOUNT, BOND_WEI, GAS_PRICE]);
  assert.deepEqual(decode(accountAbi, launch.transaction.data),
    ["launchAuctionWithCommitmentAndExactDuration", "Example Coin", "EXAMPLE", intent.floorPriceWad, 30, 5000, 1, 22_500]);
  const last = chain.state.simulations.at(-1)!;
  assert.deepEqual([last.to, last.account, last.data], [ACCOUNT, owner, launch.transaction.data]);
  assert.deepEqual(chain.launch.estimates.at(-1), { to: ACCOUNT, data: launch.transaction.data, value: BOND_WEI, account: owner, blockNumber: 100n, gasPrice: GAS_PRICE });
  assert.equal(launch.launchFee, FEE); assert.equal(launch.deployerBondWei, BOND_WEI);
  assert.deepEqual([launch.nativeBalance, launch.quoteBalance, launch.nonce], [2n * 10n ** 18n, 100_000_000n, 7]);

  chain.setLaunched();
  const done = await client.prepareLaunch(intent);
  assert.equal(done.stage, "complete"); assert.equal(done.transaction, null);
  assert.ok(done.launched && done.launch);
  assert.deepEqual([done.creatorAccount, done.launch.coin, done.launch.auction, done.launch.auctionId, done.launch.endBlock, done.launch.open, done.launch.dealStatus],
    [ACCOUNT, COIN, auction, launch.dealId, 10_000n, true, 1]);
  assert.deepEqual(done.launch.schedule, { requestedHours: 1, durationBlocks: 22_500, targetEndTimestamp: 1_700_000_000n });
  assert.equal(done.launch.bondHeld, BOND_WEI);
  const simulations = chain.state.simulations.length;
  await client.prepareLaunch(intent); assert.equal(chain.state.simulations.length, simulations, "a launched identity simulates nothing");
});
test("the creator beneficiary is the owner unless the launch names another, and an unlaunched account must keep it", async () => {
  const named = createLaunchWorld();
  const setup = await step(named.client().prepareLaunch({ ...intent, beneficiary: BENEFICIARY }));
  assert.deepEqual(decode(factoryAbi, setup.transaction.data), ["createAccountForDraft", draftSalt, BENEFICIARY]); assert.equal(setup.beneficiary, BENEFICIARY);
  named.launch.account = named.makeAccount({ beneficiary: BENEFICIARY }); named.world.allowance = FEE;
  assert.equal((await named.client().prepareLaunch({ ...intent, beneficiary: BENEFICIARY })).stage, "launch");
  await refuses(named.client().prepareLaunch(intent), "CREATOR_BINDING_MISMATCH");
});
test("terms come first when the registry enforces them and the creator has not accepted; acceptance needs the registry's own hash", async () => {
  const chain = createLaunchWorld(), client = chain.client();
  chain.launch.terms = { required: 3n, latest: 3n, accepted: 2n, hash: id32(0x7e), uri: "ipfs://terms-v3" };
  const terms = await step(client.prepareLaunch(intent));
  assert.deepEqual([terms.stage, terms.stages], ["terms", ["terms", "setup", "approve", "launch"]]);
  assert.deepEqual([terms.transaction.to, terms.transaction.value], [chain.roles.terms, 0n]);
  assert.deepEqual(decode(full("terms-registry"), terms.transaction.data), ["acceptTerms", 3n, id32(0x7e)]);
  assert.deepEqual(terms.terms, { enforced: true, accepted: false, requiredVersion: 3n, termsHash: id32(0x7e), uri: "ipfs://terms-v3" });
  chain.launch.terms.accepted = 3n;
  const accepted = await step(client.prepareLaunch(intent));
  assert.deepEqual([accepted.stage, accepted.terms.accepted], ["setup", true]);
  // A registry that enforces nothing, or contradicts itself, is not guessed at.
  chain.launch.terms = { required: 0n, latest: 0n, accepted: 0n, hash: id32(0), uri: "" };
  assert.equal((await client.prepareLaunch(intent)).stage, "setup");
  chain.launch.terms = { required: 4n, latest: 3n, accepted: 0n, hash: id32(1), uri: "" };
  await refuses(client.prepareLaunch(intent), "INVALID_TERMS_STATE");
});

test("native value: only the launch step carries the 0.5 HYPE bond, and it is refused unless the creator can cover the bond and the step's gas", async () => {
  const chain = ready(), client = chain.client();
  const launch = await step(client.prepareLaunch(intent));
  assert.equal(launch.transaction.value, 500_000_000_000_000_000n); assert.equal(launch.deployerBondWei, 500_000_000_000_000_000n);
  assert.equal(launch.estimatedGasCost, (3_000_000n * GAS_PRICE * 120n + 99n) / 100n); assert.equal(launch.gasEstimate, 3_000_000n);
  for (const earlier of [createLaunchWorld(), (() => { const c = createLaunchWorld(); c.launch.account = c.makeAccount(); return c; })()]) {
    assert.equal((await step(earlier.client().prepareLaunch(intent))).transaction.value, 0n);
  }
  // Less than the bond: refused at every step, so the creator is not walked through setup first.
  for (const world of [createLaunchWorld(), ready()]) {
    world.launch.nativeBalance = BOND_WEI - 1n;
    await refuses(world.client().prepareLaunch(intent), "INSUFFICIENT_BOND");
  }
  // The bond covered but no gas on top of it.
  const noGas = ready(); noGas.launch.nativeBalance = BOND_WEI + 1n;
  await refuses(noGas.client().prepareLaunch(intent), "INSUFFICIENT_GAS");
  const exact = ready(); exact.launch.nativeBalance = BOND_WEI + launch.estimatedGasCost;
  assert.equal((await exact.client().prepareLaunch(intent)).stage, "launch");
  exact.launch.nativeBalance -= 1n; await refuses(exact.client().prepareLaunch(intent), "INSUFFICIENT_GAS");
  // The fee is in USDC (Oxy-USDC), a separate balance from the native bond.
  const noFee = createLaunchWorld(); noFee.world.balance = FEE - 1n;
  await refuses(noFee.client().prepareLaunch(intent), "INSUFFICIENT_QUOTE");
});
test("the launch is refused above the gas price the bond escrow accepts, with the price on the step; the earlier steps are not", async () => {
  const dear = ready(); dear.launch.gasPrice = 1_000_000_001n;
  await refuses(dear.client().prepareLaunch(intent), "GAS_PRICE_TOO_HIGH");
  const setup = createLaunchWorld(); setup.launch.gasPrice = 5_000_000_000n;
  assert.equal((await setup.client().prepareLaunch(intent)).stage, "setup");
  const cap = ready(); cap.launch.gasPrice = 1_000_000_000n;
  assert.equal((await step(cap.client().prepareLaunch(intent))).transaction.gasPrice, 1_000_000_000n);
  const free = createLaunchWorld(); free.launch.gasPrice = 0n;
  await refuses(free.client().prepareLaunch(intent), "INVALID_GAS_PRICE");
});

test("a failed simulation is surfaced with its stage and the rule it broke, without the RPC's URL", async () => {
  const revert = (name: "TickerUnavailable" | "GasPriceTooHigh" | "NewEntriesPaused", args: readonly unknown[] = []) =>
    Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: oxleyRevertAbi, errorName: name, args } as never) });
  const launch = ready(); launch.world.callError = revert("TickerUnavailable", ["EXAMPLE"]);
  await assert.rejects(launch.client().prepareLaunch(intent), (error: unknown) => {
    assert.ok(error instanceof OxleyError); assert.equal(error.code, "SIMULATION_FAILED");
    assert.equal(error.details?.stage, "launch"); assert.deepEqual((error.details?.revert as { name: string; args: unknown[] }).name, "TickerUnavailable");
    assert.match(error.message, /launch step failed in simulation: The ticker "EXAMPLE" is taken/); return true;
  });
  const setup = createLaunchWorld(); setup.world.callError = revert("NewEntriesPaused");
  await assert.rejects(setup.client().prepareLaunch(intent), (error: unknown) => error instanceof OxleyError && error.code === "SIMULATION_FAILED"
    && error.details?.stage === "setup" && (error.details.revert as { name: string }).name === "NewEntriesPaused");
  // An error that decodes to no Oxley rule still surfaces, and a client error's request URL (a keyed endpoint) is replaced.
  const opaque = ready(); opaque.world.callError = new Error("HTTP request failed. URL: https://rpc.example/key-123456 Status: 500");
  await assert.rejects(opaque.client().prepareLaunch(intent), (error: unknown) => {
    assert.ok(error instanceof OxleyError); assert.equal(error.code, "SIMULATION_FAILED"); assert.equal(error.details?.revert, null);
    assert.ok(!JSON.stringify([error.message, error.details]).includes("key-123456")); assert.match(error.message, /<rpc>/); return true;
  });
  // The gas estimate runs the same step: a failure there is as final.
  const gas = ready(); gas.launch.estimateError = revert("GasPriceTooHigh");
  await assert.rejects(gas.client().prepareLaunch(intent), (error: unknown) => error instanceof OxleyError && error.code === "SIMULATION_FAILED"
    && /gas estimate/.test(error.message) && (error.details?.revert as { name: string }).name === "GasPriceTooHigh");
  // A token that answers an approval with false is not an approval.
  const approval = createLaunchWorld(); approval.launch.account = approval.makeAccount(); approval.launch.callData = `0x${"0".repeat(64)}`;
  await refuses(approval.client().prepareLaunch(intent), "APPROVAL_REJECTED");
  approval.launch.callData = `0x${"0".repeat(63)}1`; assert.equal((await approval.client().prepareLaunch(intent)).stage, "approve");
  assert.equal(launch.state.simulations.length + setup.state.simulations.length, 2, "each failure came from exactly one simulation");
});

test("what the chain would refuse is refused before any step: ticker, deal id, floor, pause, nonce and the account's identity", async () => {
  const checks: [string, (chain: LaunchWorld) => void][] = [
    ["TICKER_UNAVAILABLE", chain => { chain.launch.tickerAvailable = false; }],
    ["DEAL_ID_USED", chain => { chain.launch.deal = { ...chain.launch.deal, creator: addr(77) }; }],
    ["FLOOR_MISMATCH", chain => { chain.launch.floor = [1n, 2n]; }],
    ["LAUNCH_PAUSED", chain => { chain.launch.enabled = false; }], ["LAUNCH_PAUSED", chain => { chain.launch.paused = true; }],
    ["PENDING_TRANSACTION", chain => { chain.launch.pending = 8; }],
    ["LAUNCH_ID_MISMATCH", chain => { chain.launch.dealIdFor = id32(0xbad); }],
    ["INVALID_CREATOR_ACCOUNT", chain => { chain.launch.account = chain.makeAccount({ registered: false }); }],
    ["CREATOR_BINDING_MISMATCH", chain => { chain.launch.account = chain.makeAccount({ initialController: addr(77) }); }],
    ["CREATOR_BINDING_MISMATCH", chain => { chain.launch.account = chain.makeAccount({ bondBeneficiary: addr(77) }); }],
    ["CREATOR_BINDING_MISMATCH", chain => { chain.launch.account = chain.makeAccount({ dealId: id32(0xbad) }); }],
    ["CREATOR_BINDING_MISMATCH", chain => { chain.launch.account = chain.makeAccount({ auctionController: addr(77) }); }],
    ["CREATOR_BINDING_MISMATCH", chain => { chain.launch.account = chain.makeAccount({ quoteAsset: addr(77) }); }],
    ["CREATOR_BINDING_MISMATCH", chain => { chain.launch.account = chain.makeAccount({ bondEscrow: addr(77) }); }],
    ["CREATOR_BINDING_MISMATCH", chain => { chain.launch.account = chain.makeAccount({ controller: addr(77) }); }],
  ];
  for (const [expected, change] of checks) {
    const chain = createLaunchWorld(); change(chain);
    await refuses(chain.client().prepareLaunch(intent), expected);
    assert.equal(chain.state.simulations.length, 0, expected);
  }
  // The pending nonce moving while the step is prepared invalidates it.
  const moved = createLaunchWorld(); moved.launch.nonceAfter = 8;
  await refuses(moved.client().prepareLaunch(intent), "NONCE_CHANGED");
  // A launch that already happened stays reported, whatever has been paused or handed over since.
  const done = createLaunchWorld(); done.setLaunched({ controller: addr(77), beneficiary: addr(78) }); done.launch.enabled = false; done.launch.tickerAvailable = false;
  const complete = await done.client().prepareLaunch(intent);
  assert.deepEqual([complete.stage, complete.launched], ["complete", true]);
  const reorg = createLaunchWorld(); reorg.state.reorg = true;
  await refuses(reorg.client().prepareLaunch(intent), "REORG");
});
test("without a block rate the chain is sampled, and a rate outside the contract's range or too little history is refused", async () => {
  const { secondsPerBlock: _rate, ...sampled } = intent;
  // The test chain's head is block 100: the manifest's start block leaves too little history to measure a rate.
  await refuses(ready().client().prepareLaunch(sampled), "INSUFFICIENT_BLOCK_HISTORY");
  const explicit = await step(ready().client().prepareLaunch({ ...sampled, durationBlocks: 30_000 }));
  assert.equal(explicit.durationBlocks, 30_000);
  // An explicit length wins over a rate; a rate alone converts the hours.
  assert.equal((await step(ready().client().prepareLaunch({ ...intent, durationBlocks: 30_000 }))).durationBlocks, 30_000);
  assert.equal((await step(ready().client().prepareLaunch({ ...intent, auctionDurationHours: 24, secondsPerBlock: 0.0625 }))).durationBlocks, 1_382_400);
  await refuses(ready().client().prepareLaunch({ ...intent, secondsPerBlock: 0.02 }), "INVALID_DURATION_BLOCKS");
  // The sampler measures (head - base) / blocks over a window ending at the observation block and never before the start block.
  const chain = (rate: number) => ({ getBlock: async (p: { blockNumber?: bigint }) => ({ number: p.blockNumber ?? 50_000n, hash: id32(5), timestamp: 1_000n + BigInt(Math.round(Number(p.blockNumber ?? 50_000n) * rate * 1000)) / 1000n }) });
  const sample = await sampleSecondsPerBlock(chain(0.16) as never, { blocks: 20_000 });
  assert.equal(sample.blocks, 20_000); assert.equal(sample.toBlock, 50_000n); assert.equal(sample.fromBlock, 30_000n); assert.ok(Math.abs(sample.secondsPerBlock - 0.16) < 1e-3);
  assert.equal((await sampleSecondsPerBlock(chain(0.16) as never, { notBefore: 45_000n })).blocks, 5_000);
  await assert.rejects(sampleSecondsPerBlock(chain(0.16) as never, { notBefore: 49_500n }), code("INSUFFICIENT_BLOCK_HISTORY"));
  await assert.rejects(sampleSecondsPerBlock(chain(0.16) as never, { blocks: 999 }), code("INVALID_SAMPLE"));
  await assert.rejects(sampleSecondsPerBlock(chain(0) as never), code("INVALID_BLOCK_RATE"));
});

test("the launch read back: nothing before setup, the account after it, and once launched the coin, auction, schedule and bond", async () => {
  const chain = createLaunchWorld(), client = chain.client();
  const none = await client.getLaunch({ owner, draftSalt });
  assert.deepEqual([none.creatorAccount, none.launched, none.launch], [null, false, null]);
  assert.equal(none.dealId, chain.dealId);
  chain.launch.account = chain.makeAccount({ bondRefundBalance: 5n });
  const account = await client.getLaunch({ owner, draftSalt });
  assert.deepEqual([account.creatorAccount, account.launched, account.launch, account.scheduled, account.bondRefundable], [ACCOUNT, false, null, false, 5n]);
  chain.setLaunched({ bondRefundBalance: 7n });
  const done = await client.getLaunch({ owner, draftSalt });
  assert.deepEqual([done.launched, done.launch?.coin, done.launch?.auction, done.launch?.bondHeld, done.bondRefundable], [true, COIN, auction, BOND_WEI, 7n]);
  assert.deepEqual(done.launch?.schedule, { requestedHours: 1, durationBlocks: 22_500, targetEndTimestamp: 1_700_000_000n });
  // The controller's campaign and the registry's deal must both name this account and coin.
  chain.launch.deal = { ...chain.launch.deal, coin: addr(77) };
  await refuses(client.getLaunch({ owner, draftSalt }), "LAUNCH_BINDING_MISMATCH");
  chain.setLaunched(); chain.launch.deal = { ...chain.launch.deal, controller: addr(77) };
  await refuses(client.getLaunch({ owner, draftSalt }), "LAUNCH_BINDING_MISMATCH");
  await refuses(client.getLaunch({ owner: addr(0), draftSalt }), "INVALID_ADDRESS");
  await refuses(client.getLaunch({ owner, draftSalt: id32(0) }), "INVALID_HASH");
});
test("the launch client takes the reviewed manifest and refuses one without launch bindings, with the bond or fee changed, or reusing a contract", () => {
  const good = manifest(), { launchBindings } = good;
  assert.doesNotThrow(() => createOxleyLaunchClient({ publicClient: createLaunchWorld().rpc, deployment: good }));
  const { launchBindings: _removed, ...without } = good;
  // The bindings are optional for the manifest and required by the launch client alone (see test/deployment.test.ts for the trading and auction clients).
  assert.throws(() => createOxleyLaunchClient({ publicClient: createLaunchWorld().rpc, deployment: without }), code("LAUNCH_BINDINGS_REQUIRED"));
  assert.throws(() => parseLaunchDeployment(without), code("LAUNCH_BINDINGS_REQUIRED"));
  assert.doesNotThrow(() => parseDeployment(without));
  // When they are present they are validated in full, whoever reads the manifest.
  for (const key of ["creatorAccountFactory", "entryController", "bondEscrow"] as const) {
    const { [key]: _pin, ...rest } = launchBindings;
    assert.throws(() => parseDeployment({ ...good, launchBindings: rest }), code("LAUNCH_BINDINGS_REQUIRED"), key);
    assert.throws(() => parseDeployment({ ...good, launchBindings: { ...launchBindings, [key]: good.curve } }), code("INVALID_DEPLOYMENT"), key);
  }
  assert.throws(() => parseDeployment({ ...good, launchBindings: { ...launchBindings, deployerBondWei: "1" } }), code("INVALID_BOND"));
  for (const launchFeeBaseUnits of ["0", "-1", "1.5", "", 1500000, undefined]) {
    assert.throws(() => parseDeployment({ ...good, launchBindings: { ...launchBindings, launchFeeBaseUnits } }), code("INVALID_LAUNCH_COST"), String(launchFeeBaseUnits));
  }
  assert.ok(Object.isFrozen(parseLaunchDeployment(good).launchBindings) && Object.isFrozen(parseLaunchDeployment(good).launchBindings.bondEscrow));
});
