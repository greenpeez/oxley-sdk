import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BaseError, ContractFunctionRevertedError, RawContractError, decodeFunctionData, encodeErrorResult,
  encodeFunctionData, keccak256, maxUint256, toHex, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { createOxleyClient, decodeOxleyRevert, deploymentGeneration, parseDeployment, OxleyError } from "../src/index.js";
import { createOxleyLaunchClient, buildAuctionLaunch, auctionDurationBounds, auctionDurationBlocks, sampleSecondsPerBlock,
  validateAuctionLaunch, parseLaunchDeployment, quoteAuctionFloor, creatorAccountAbi, creatorAccountFactoryAbi,
  launchControllerAbi, launchFloorAbi, type AuctionLaunchInput, type LaunchRpcClient } from "../src/launch.js";
import { createOxleyAuctionClient, auctionControllerAbi, auctionBidRouterAbi, auctionAdapterAbi } from "../src/auctions.js";
import { curveAbi, gen2CreatorAccountAbi, gen2AuctionControllerAbi, breadthBidHookAbi, gen2CurveAbi, oxleyRevertAbi } from "../src/abis.js";
import type { RpcClient } from "../src/types.js";

const addr = (n: number) => toHex(n, { size: 20 });
const id = toHex(1, { size: 32 }), owner = addr(9), account = addr(15), coin = addr(6), auction = addr(8), hook = addr(7);
const pin = (n: number) => ({ address: addr(n), runtimeCodeHash: keccak256("0x6000") });
const flat = { schemaVersion: 1, releaseId: "test", chainId: 31337, network: "testnet", startBlock: "1",
  curve: pin(1), registry: pin(2), quoteToken: { ...pin(3), decimals: 6, symbol: "Oxy-USDC" }, auctionController: addr(4),
  auctionBindings: { controllerRuntimeCodeHash: keccak256("0x6000"), bidRouter: pin(5), adapter: pin(11) },
  launchBindings: { creatorAccountFactory: pin(12), entryController: pin(13), bondEscrow: pin(14),
    launchFeeBaseUnits: "1500000", deployerBondWei: "500000000000000000" } };
const gen2 = { ...flat, releaseId: "gen2-test", generation: "gen2" };
const input: AuctionLaunchInput = { owner, dealId: id, name: "SDK Launch", symbol: "SDK", floorPriceWad: 10n ** 19n,
  creatorLockDays: 30, listingCommitmentBps: 5000, auctionDurationHours: 1 };
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const full = (name: string) => JSON.parse(read(`../abis/${name}.json`)) as Abi;
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const code = (expected: string) => (e: unknown) => e instanceof OxleyError && e.code === expected;
const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([k, v]) => !["name", "internalType"].includes(k) && !(["indexed", "anonymous"].includes(k) && v === false))
    .map(([k, v]) => [k, shape(v)]));
  return value;
};
const matches = (entry: { type: string; name?: string }, abi: Abi) => abi.some(candidate => candidate.type === entry.type
  && "name" in candidate && candidate.name === entry.name && isDeepStrictEqual(shape(candidate), shape(entry)));

test("Gen2 ABIs are byte-identical to the evidence and every typed subset matches the full ABIs", () => {
  const evidence = JSON.parse(read("../docs/gen2-artifacts.json")), pkg = JSON.parse(read("../package.json"));
  assert.equal(evidence.evidence.length, 7);
  for (const item of evidence.evidence) {
    assert.equal(sha(readFileSync(new URL(`../abis/${item.name}.json`, import.meta.url))), item.abiSha256, item.name);
    assert.equal(item.sourceCommit, "4cf4da65684ca8052b9f6f1bd67566f49ea6463d");
    assert.equal(pkg.exports[item.export.replace("@oxley/sdk", ".")], `./abis/${item.name}.json`);
  }
  const [controller, account, factory, router, adapter, curve, bidHook] = ["ElysiumBondedCcaLaunchControllerGen2",
    "ElysiumCreatorAccountGen2", "ElysiumCreatorAccountFactoryGen2", "ElysiumCcaBidRouterGen2",
    "ElysiumUniswapCcaAdapterGen2", "ElysiumReserveCurveGen2", "ElysiumBreadthCcaBidHook"].map(full) as Abi[];
  const subsets: [readonly { type: string; name?: string }[], Abi][] = [
    [gen2CreatorAccountAbi, account!], [gen2AuctionControllerAbi, controller!], [breadthBidHookAbi, bidHook!], [gen2CurveAbi, curve!],
    // Flat-fee subsets the SDK keeps reading must be unchanged in the Gen2 contracts.
    [auctionControllerAbi, controller!], [launchControllerAbi, controller!], [auctionBidRouterAbi, router!],
    [auctionAdapterAbi, adapter!], [launchFloorAbi, adapter!], [curveAbi, curve!], [creatorAccountAbi, account!],
    [creatorAccountFactoryAbi, factory!],
  ];
  for (const [subset, abi] of subsets) for (const entry of subset) assert.ok(matches(entry, abi), `${entry.type} ${entry.name}`);
  const sources = [bidHook!, curve!, controller!, full("ContinuousClearingAuction"), ...["OxleyTermsRegistry", "ElysiumReserveCurveGen3", "ElysiumCurveGen8",
    "ElysiumCcaBidRouterGen8", "ElysiumDynamicBidHookGen8"].map(full)];
  for (const entry of oxleyRevertAbi) assert.ok(sources.some(abi => matches(entry, abi)), entry.name);
});
test("Gen2 manifest is the fork deployment plus generation/status and parses without changing flat-fee parsing", () => {
  const evidence = JSON.parse(read("../docs/gen2-artifacts.json")), json = JSON.parse(read("../deployments/elysium-testnet-gen2.json"));
  const { generation, status, note, ...source } = json;
  assert.equal(sha(JSON.stringify(source, null, 2)), evidence.deployment.sourceSha256);
  assert.deepEqual([generation, status, typeof note], ["gen2", "planned-fork-addresses", "string"]);
  const parsed = parseLaunchDeployment(json);
  assert.equal(parsed.generation, "gen2"); assert.equal(parsed.status, "planned-fork-addresses");
  assert.equal(deploymentGeneration(parsed), "gen2"); assert.ok(Object.isFrozen(parsed));
  const current = parseLaunchDeployment(JSON.parse(read("../deployments/elysium-testnet.json")));
  assert.equal(current.generation, undefined); assert.equal(deploymentGeneration(current), "flat-fee");
  assert.equal(parseDeployment({ ...flat, generation: "flat-fee", status: "live" }).status, "live");
  for (const patch of [{ generation: "gen3" }, { generation: 2 }, { status: "" }, { status: 1 }, { note: "" }]) {
    assert.throws(() => parseDeployment({ ...flat, ...patch }));
  }
  assert.equal(JSON.parse(read("../package.json")).exports["./deployments/elysium-testnet-gen2.json"], "./deployments/elysium-testnet-gen2.json");
});
test("duration bounds accept both edges and reject one block beyond them for 1 h and 24 h", () => {
  assert.deepEqual(auctionDurationBounds(1), { minimumBlocks: 14_400, maximumBlocks: 36_000 });
  assert.deepEqual(auctionDurationBounds(24), { minimumBlocks: 345_600, maximumBlocks: 864_000 });
  for (const hours of [0, 25, 1.5, NaN, Infinity, "1"]) assert.throws(() => auctionDurationBounds(hours as number), code("INVALID_DURATION"));
  for (const [hours, min, max] of [[1, 14_400, 36_000], [24, 345_600, 864_000]] as const) {
    for (const durationBlocks of [min, max]) {
      assert.doesNotThrow(() => validateAuctionLaunch({ ...input, auctionDurationHours: hours, durationBlocks }));
    }
    for (const durationBlocks of [min - 1, max + 1, min + 0.5]) {
      assert.throws(() => validateAuctionLaunch({ ...input, auctionDurationHours: hours, durationBlocks }), code("INVALID_DURATION_BLOCKS"));
    }
    assert.equal(auctionDurationBlocks({ hours, secondsPerBlock: 0.25 }), min);
    assert.equal(auctionDurationBlocks({ hours, secondsPerBlock: 0.1 }), max);
  }
  for (const secondsPerBlock of [0.2501, 0.0999]) {
    assert.throws(() => auctionDurationBlocks({ hours: 1, secondsPerBlock }), code("INVALID_DURATION_BLOCKS"));
  }
  assert.throws(() => auctionDurationBlocks({ hours: 1, secondsPerBlock: 0.3 }), /outside the 0\.10-0\.25 s range/);
  for (const secondsPerBlock of [0, -0.1, NaN, Infinity, "0.14"]) {
    assert.throws(() => auctionDurationBlocks({ hours: 1, secondsPerBlock: secondsPerBlock as number }), code("INVALID_BLOCK_RATE"));
    assert.throws(() => validateAuctionLaunch({ ...input, secondsPerBlock: secondsPerBlock as number }), code("INVALID_BLOCK_RATE"));
  }
  assert.throws(() => auctionDurationBlocks({ hours: 0, secondsPerBlock: 0.14 }), code("INVALID_DURATION"));
});
test("block counts round hours x 3600 / secondsPerBlock to the nearest block", () => {
  assert.equal(auctionDurationBlocks({ hours: 1, secondsPerBlock: 0.1363 }), 26_412);
  assert.equal(auctionDurationBlocks({ hours: 1, secondsPerBlock: 0.1408 }), 25_568);
  assert.equal(auctionDurationBlocks({ hours: 24, secondsPerBlock: 0.1363 }), 633_896);
  assert.equal(auctionDurationBlocks({ hours: 2, secondsPerBlock: 0.15 }), 48_000);
});

/** Chain whose blocks advance 0.1363 s each, with the head at the current wall-clock time. */
function blocks(head = 30_000n, step = 1363n) {
  const now = BigInt(Math.floor(Date.now() / 1000)), reads: bigint[] = [];
  const timestamp = (n: bigint) => now - (head - n) * step / 10_000n;
  const getBlock = async (args: { blockNumber?: bigint }) => {
    const number = args.blockNumber ?? head; reads.push(number);
    return { number, timestamp: timestamp(number), hash: toHex(number + 1n, { size: 32 }) };
  };
  return { now, reads, getBlock };
}
test("block-rate sampling uses up to 20,000 blocks, never before the deployment, and refuses short history", async () => {
  const chain = blocks(), rpc = { getBlock: chain.getBlock } as unknown as RpcClient;
  const sample = await sampleSecondsPerBlock(rpc);
  assert.deepEqual([sample.blocks, sample.secondsPerBlock, sample.fromBlock, sample.toBlock], [20_000, 0.1363, 10_000n, 30_000n]);
  const short = await sampleSecondsPerBlock(rpc, { notBefore: 25_000n });
  assert.deepEqual([short.blocks, short.fromBlock, short.secondsPerBlock], [5_000, 25_000n, 0.1362]);
  await assert.rejects(sampleSecondsPerBlock(rpc, { notBefore: 29_500n }), code("INSUFFICIENT_BLOCK_HISTORY"));
  await assert.rejects(sampleSecondsPerBlock(rpc, { blocks: 10 }), code("INVALID_SAMPLE"));
  const frozen = blocks(30_000n, 0n);
  await assert.rejects(sampleSecondsPerBlock({ getBlock: frozen.getBlock } as unknown as RpcClient), code("INVALID_BLOCK_RATE"));
});
test("Gen2 launch encodes the exact-duration account method; flat-fee keeps the hours-only method", () => {
  const gen2Account = full("ElysiumCreatorAccountGen2");
  const launch = buildAuctionLaunch({ ...input, deployment: gen2, creatorAccount: account, secondsPerBlock: 0.1363 });
  assert.equal(launch.to, account); assert.equal(launch.value, 500_000_000_000_000_000n); assert.equal(launch.data.slice(0, 10), "0x2ea4fd90");
  assert.equal(launch.data, encodeFunctionData({ abi: gen2Account, functionName: "launchAuctionWithCommitmentAndExactDuration",
    args: [input.name, input.symbol, input.floorPriceWad, 30, 5000, 1, 26_412] }));
  const explicit = buildAuctionLaunch({ ...input, deployment: gen2, creatorAccount: account, secondsPerBlock: 0.1363, durationBlocks: 30_000 });
  assert.deepEqual(decodeFunctionData({ abi: gen2Account, data: explicit.data }).args?.slice(-2), [1, 30_000]);
  assert.throws(() => buildAuctionLaunch({ ...input, deployment: gen2, creatorAccount: account }), code("DURATION_BLOCKS_REQUIRED"));
  assert.throws(() => buildAuctionLaunch({ ...input, deployment: gen2, creatorAccount: account, secondsPerBlock: 0.3 }), code("INVALID_DURATION_BLOCKS"));
  const hoursOnly = buildAuctionLaunch({ ...input, deployment: flat, creatorAccount: account });
  assert.deepEqual(Object.keys(hoursOnly), ["chainId", "to", "value", "data"]);
  assert.equal(hoursOnly.data, encodeFunctionData({ abi: full("ElysiumCreatorAccount"), functionName: "launchAuctionWithCommitmentAndDuration",
    args: [input.name, input.symbol, input.floorPriceWad, 30, 5000, 1] }));
  for (const extra of [{ secondsPerBlock: 0.1363 }, { durationBlocks: 26_412 }]) {
    assert.throws(() => buildAuctionLaunch({ ...input, ...extra, deployment: flat, creatorAccount: account }), code("EXACT_DURATION_UNSUPPORTED"));
  }
});

function launchFixture(manifest: object = gen2) {
  const chain = blocks();
  const state = { bounds: null as null | readonly [number, number], launched: false, reads: [] as string[], calls: [] as Record<string, unknown>[] };
  const rpc = {
    getChainId: async () => 31337, getBlock: chain.getBlock, getCode: async () => "0x6000" as Hex,
    getBalance: async () => 10n ** 18n, getGasPrice: async () => 100n, getTransactionCount: async () => 0,
    estimateGas: async () => 100_000n,
    readContract: async ({ address: target, functionName: f, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
      state.reads.push(f);
      const floor = quoteAuctionFloor(input.floorPriceWad), hours = Number(args?.[0] ?? 0);
      const values: Record<string, unknown> = {
        feeBidRouter: addr(5), ccaAdapter: addr(11), quoteAsset: addr(3), registry: addr(2), adapter: addr(11),
        controller: target === account ? owner : addr(4), validationHook: hook, decimals: 6, campaign: [account, coin, id, 200n, true],
        deal: { creator: state.launched ? account : zeroAddress, coin, controller: addr(4), reserveAsset: addr(3), profile: 1, status: 2 },
        auctionFor: auction, token: coin, currency: addr(3), creatorAccountFactory: addr(12), entryController: addr(13),
        bondEscrow: addr(14), auctionController: addr(4), launchFee: 1_500_000n, CREATOR_DEPOSIT: 500_000_000_000_000_000n,
        MAX_GAS_PRICE: 1_000_000_000n, publicLaunchEnabled: true, entriesPaused: false, accountFor: account, isAccount: true,
        initialController: owner, bondBeneficiary: owner, beneficiary: owner, dealId: id, launched: state.launched, coin,
        isTickerAvailable: true, effectiveFloor: [floor.floorPriceQ96, floor.tickSpacingQ96], balanceOf: 1_500_000n,
        allowance: 1_500_000n, durationBounds: state.bounds ?? [hours * 14_400, hours * 36_000], schedule: [1, 26_412, 1_000n],
      };
      assert.ok(f in values, f); return values[f];
    },
    call: async (args: Record<string, unknown>) => { state.calls.push(args); return { data: "0x" }; },
  } as unknown as LaunchRpcClient;
  return { state, chain, client: createOxleyLaunchClient({ publicClient: rpc, deployment: manifest }) };
}
test("Gen2 prepareLaunch samples the live block rate and simulates the exact-duration launch", async () => {
  const { state, client } = launchFixture(), step = await client.prepareLaunch(input);
  assert.ok(step.stage === "launch" && step.transaction);
  assert.deepEqual([step.requestedHours, step.durationBlocks, step.secondsPerBlock, step.rateSample?.blocks], [1, 26_412, 0.1363, 20_000]);
  assert.deepEqual(step.durationBounds, { minimumBlocks: 14_400, maximumBlocks: 36_000 });
  assert.equal(step.estimatedEndTimestamp, step.timestamp + 3600n);
  const decoded = decodeFunctionData({ abi: gen2CreatorAccountAbi, data: step.transaction.data });
  assert.equal(decoded.functionName, "launchAuctionWithCommitmentAndExactDuration");
  assert.deepEqual(decoded.args.slice(-2), [1, 26_412]);
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0]?.data, step.transaction.data);
  assert.ok(state.reads.includes("durationBounds"));
  state.launched = true;
  const complete = await client.prepareLaunch(input);
  assert.equal(complete.stage, "complete");
  assert.deepEqual("schedule" in complete && complete.schedule, { requestedHours: 1, durationBlocks: 26_412, targetEndTimestamp: 1_000n });
});
const prepared = <T extends { stage: string }>(step: T) => {
  assert.notEqual(step.stage, "complete"); return step as Exclude<T, { stage: "complete" }>;
};
test("Gen2 prepareLaunch fails closed on bound mismatches and short history unless a rate or length is supplied", async () => {
  const mismatch = launchFixture(); mismatch.state.bounds = [14_401, 36_000];
  await assert.rejects(mismatch.client.prepareLaunch(input), code("DURATION_BOUNDS_MISMATCH"));
  assert.equal(mismatch.state.calls.length, 0);
  const recent = launchFixture({ ...gen2, startBlock: "25000" }), sampled = prepared(await recent.client.prepareLaunch(input));
  assert.deepEqual([sampled.rateSample?.blocks, sampled.durationBlocks], [5_000, 26_432]);
  const fresh = launchFixture({ ...gen2, startBlock: "29500" });
  await assert.rejects(fresh.client.prepareLaunch(input), code("INSUFFICIENT_BLOCK_HISTORY"));
  const supplied = prepared(await fresh.client.prepareLaunch({ ...input, secondsPerBlock: 0.14 }));
  assert.deepEqual([supplied.durationBlocks, supplied.rateSample, supplied.secondsPerBlock], [25_714, null, 0.14]);
  const explicit = prepared(await fresh.client.prepareLaunch({ ...input, durationBlocks: 30_000 }));
  assert.deepEqual([explicit.durationBlocks, explicit.secondsPerBlock, explicit.estimatedEndTimestamp], [30_000, null, null]);
});
test("flat-fee prepareLaunch keeps the hours-only call, adds no reads and rejects exact-duration inputs", async () => {
  const { state, chain, client } = launchFixture(flat), step = await client.prepareLaunch(input);
  assert.ok(step.stage === "launch" && step.transaction);
  assert.equal(step.transaction.data, encodeFunctionData({ abi: creatorAccountAbi, functionName: "launchAuctionWithCommitmentAndDuration",
    args: [input.name, input.symbol, input.floorPriceWad, 30, 5000, 1] }));
  assert.ok(!("durationBlocks" in step) && !state.reads.includes("durationBounds"));
  assert.ok(chain.reads.every(n => n === 30_000n));
  await assert.rejects(client.prepareLaunch({ ...input, secondsPerBlock: 0.1363 }), code("EXACT_DURATION_UNSUPPORTED"));
});

function auctionFixture(manifest: object = gen2) {
  const state = { registered: true, cap: 5_050_505_051n, minimum: 50_505_050_505n, counted: 0n, committed: 0n, excluded: false,
    hookRouter: addr(5), override: undefined as bigint | undefined, allowance: 0n, reads: [] as string[], calls: [] as Record<string, unknown>[] };
  const walletAllowance = () => state.override ?? (!state.registered || state.excluded ? 0n
    : state.counted >= state.minimum ? maxUint256 : state.committed >= state.cap ? 0n : state.cap - state.committed);
  const rpc = {
    getChainId: async () => 31337,
    getBlock: async () => ({ number: 100n, timestamp: 1000n, hash: toHex(1, { size: 32 }) }),
    getCode: async () => "0x6000",
    readContract: async ({ functionName: f }: { functionName: string }) => {
      state.reads.push(f);
      const values: Record<string, unknown> = {
        feeBidRouter: addr(5), ccaAdapter: addr(11), quoteAsset: addr(3), registry: addr(2), adapter: addr(11), controller: addr(4),
        validationHook: hook, decimals: 6, campaign: [owner, coin, id, 200n, true],
        deal: { creator: owner, coin, controller: addr(4), reserveAsset: addr(3), profile: 1, status: 2 },
        auctionFor: auction, token: coin, currency: addr(3), quoteBid: [100_000_000n, 100_100_000n, 100_000n],
        startBlock: 100n, endBlock: 200n, currentBlock: 150n, floorPrice: 100n, tickSpacing: 10n, MAX_BID_PRICE: 10_000n,
        balanceOf: 100_100_000n, allowance: state.allowance,
        bidRouter: state.hookRouter, isRegistered: state.registered, walletAllowance: walletAllowance(),
        walletCap: state.registered ? state.cap : 0n, minimumGrossRaise: state.registered ? state.minimum : 0n,
        counted: state.counted, breadthReached: state.registered && state.counted >= state.minimum,
        committed: state.committed, isExcludedBidder: state.registered && state.excluded,
      };
      assert.ok(f in values, f); return values[f];
    },
    call: async (args: Record<string, unknown>) => { state.calls.push(args); return { data: "0x" }; },
  } as unknown as RpcClient;
  return { state, client: createOxleyAuctionClient({ publicClient: rpc, deployment: manifest }) };
}
const bid = { dealId: id, entered: 100_000_000n, maxPriceQ96: 1000n, previousTick: 100n, deadline: 2000n, caller: addr(20) };
test("getBidAllowance reports capped, unlimited and creator-excluded hook state", async () => {
  const { state, client } = auctionFixture();
  state.committed = 5_000_000_000n;
  const capped = await client.getBidAllowance({ dealId: id, owner: bid.caller });
  assert.deepEqual([capped.walletAllowance, capped.unlimited, capped.walletCap, capped.minimumGrossRaise, capped.counted,
    capped.breadthReached, capped.committed, capped.creatorExcluded, capped.registered, capped.hook, capped.auction],
  [50_505_051n, false, 5_050_505_051n, 50_505_050_505n, 0n, false, 5_000_000_000n, false, true, hook, auction]);
  assert.equal(capped.blockNumber, 100n);
  state.counted = state.minimum;
  const unlimited = await client.getBidAllowance({ dealId: id, owner: bid.caller });
  assert.deepEqual([unlimited.walletAllowance, unlimited.unlimited, unlimited.breadthReached], [maxUint256, true, true]);
  state.excluded = true;
  const creator = await client.getBidAllowance({ dealId: id, owner });
  assert.deepEqual([creator.walletAllowance, creator.unlimited, creator.creatorExcluded], [0n, false, true]);
  state.hookRouter = addr(99);
  await assert.rejects(client.getBidAllowance({ dealId: id, owner }), code("AUCTION_BINDING_MISMATCH"));
  state.hookRouter = addr(5); state.excluded = false; state.override = 1n;
  await assert.rejects(client.getBidAllowance({ dealId: id, owner }), code("INVALID_BID_HOOK_STATE"));
  await assert.rejects(auctionFixture(flat).client.getBidAllowance({ dealId: id, owner }), code("GEN2_REQUIRED"));
});
test("Gen2 prepareBid fails closed for creators and over-cap principal before simulation", async () => {
  const { state, client } = auctionFixture(); state.allowance = 100_100_000n;
  state.committed = 5_000_000_000n;
  await assert.rejects(client.prepareBid({ ...bid, simulate: true }), (e: unknown) => code("WALLET_CAP_EXCEEDED")(e)
    && /up to 50\.505051 Oxy-USDC more until this auction has broad support/.test((e as Error).message)
    && (e as OxleyError).details?.walletAllowance === 50_505_051n);
  state.committed = state.cap;
  await assert.rejects(client.prepareBid({ ...bid, simulate: true }), /reached its bid limit/);
  state.excluded = true;
  await assert.rejects(client.prepareBid({ ...bid, simulate: true }), (e: unknown) => code("CREATOR_BID_NOT_ALLOWED")(e)
    && /Creators can't bid on their own auction/.test((e as Error).message));
  state.registered = false;
  await assert.rejects(client.prepareBid({ ...bid, simulate: true }), code("AUCTION_NOT_REGISTERED"));
  assert.equal(state.calls.length, 0);
  state.registered = true; state.excluded = false; state.committed = 0n;
  const allowed = await client.prepareBid({ ...bid, simulate: true });
  assert.equal(allowed.bidAllowance?.walletAllowance, 5_050_505_051n); assert.equal(state.calls.length, 1);
  state.counted = state.minimum;
  assert.equal((await client.prepareBid(bid)).bidAllowance?.unlimited, true);
  const legacy = auctionFixture(flat), result = await legacy.client.prepareBid(bid);
  assert.ok(!("bidAllowance" in result) && !legacy.state.reads.some(f => ["walletAllowance", "isRegistered", "bidRouter"].includes(f)));
});
test("decodeOxleyRevert names every Gen2 rule error from raw data, viem errors and the CCA hook wrapper", () => {
  const hookAbi = full("ElysiumBreadthCcaBidHook"), controller = full("ElysiumBondedCcaLaunchControllerGen2");
  const cap = encodeErrorResult({ abi: hookAbi, errorName: "WalletCapExceeded", args: [owner, 60_000_000_000n, 5_050_505_051n] });
  const cases: [Hex, string, unknown[], RegExp][] = [
    [cap, "WalletCapExceeded", [owner, 60_000_000_000n, 5_050_505_051n], /^You can bid up to 5050\.505051 USDC more until this auction has broad support$/],
    [encodeErrorResult({ abi: hookAbi, errorName: "CreatorBidNotAllowed", args: [owner] }), "CreatorBidNotAllowed", [owner], /^Creators can't bid on their own auction$/],
    [encodeErrorResult({ abi: hookAbi, errorName: "AuctionNotRegistered", args: [auction] }), "AuctionNotRegistered", [auction], /not registered/],
    [encodeErrorResult({ abi: full("ElysiumReserveCurveGen2"), errorName: "TradingNotOpen", args: [id, 1_790_000_000n] }), "TradingNotOpen",
      [id, 1_790_000_000n], /^Trading opens after all bids are delivered \(by 2026-09-21T14:13:20Z at the latest\)$/],
    [encodeErrorResult({ abi: full("ElysiumCreatorAccountGen2"), errorName: "ExactDurationRequired" }), "ExactDurationRequired", [], /exact auction length/],
    [encodeErrorResult({ abi: controller, errorName: "InvalidDurationBlocks", args: [14_399, 14_400, 36_000] }), "InvalidDurationBlocks",
      [14_399, 14_400, 36_000], /14399 blocks is outside the accepted 14400-36000 blocks/],
    [encodeErrorResult({ abi: controller, errorName: "InvalidRequestedHours", args: [25] }), "InvalidRequestedHours", [25], /1-24 whole hours/],
  ];
  for (const [data, name, args, message] of cases) {
    for (const wrapped of [data, new BaseError("Execution reverted", { cause: new RawContractError({ data }) }), { error: { code: 3, data } }]) {
      const decoded = decodeOxleyRevert(wrapped);
      assert.ok(decoded, name); assert.equal(decoded.name, name); assert.deepEqual(decoded.args, args); assert.match(decoded.message, message);
    }
  }
  const viemError = new ContractFunctionRevertedError({ abi: hookAbi, data: cap, functionName: "checkBid" });
  assert.equal(decodeOxleyRevert(viemError)?.name, "WalletCapExceeded");
  const wrappedByCca = encodeErrorResult({ abi: full("ContinuousClearingAuction"), errorName: "ValidationHookCallFailed", args: [cap] });
  assert.equal(decodeOxleyRevert(wrappedByCca)?.name, "WalletCapExceeded");
  assert.match(decodeOxleyRevert(cap, { quoteSymbol: "Oxy-USDC" })?.message ?? "", /Oxy-USDC/);
  const full0 = encodeErrorResult({ abi: hookAbi, errorName: "WalletCapExceeded", args: [owner, 1n, 0n] });
  assert.match(decodeOxleyRevert(full0)?.message ?? "", /reached its bid limit/);
  const stringRevert = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], errorName: "Error", args: ["no"] });
  for (const other of ["0xdeadbeef", "0x", stringRevert, new Error("network"), null, 42, { data: { data: "nothex" } }]) {
    assert.equal(decodeOxleyRevert(other), null);
  }
});

function marketFixture(manifest: object) {
  const state = { open: false, activatedAt: 900n, fallbackAt: 1500n, timestamp: 1000n, reads: [] as string[], allowance: 0n };
  const rpc = {
    getChainId: async () => 31337,
    getBlock: async (p: { blockNumber?: bigint }) => ({ number: p.blockNumber ?? 100n, hash: toHex(456n, { size: 32 }), timestamp: state.timestamp }),
    getCode: async () => "0x6000", call: async () => ({ data: "0x" }), estimateGas: async () => 200_000n,
    readContract: async (p: { address: Address; functionName: string }) => {
      state.reads.push(p.functionName);
      const values: Record<string, unknown> = {
        quoteAsset: addr(3), decimals: p.address === addr(3) ? 6 : 18,
        deal: { creator: owner, coin: addr(5), controller: addr(4), reserveAsset: addr(3), profile: 1, status: 3 },
        market: { active: true, creator: owner, coin: addr(5), reserveAsset: addr(3), activatedAt: state.activatedAt },
        quoteBuy: [900_000n, 20_000n], quoteSell: [900_000n, 0n, 20_000n], balanceOf: 2_000_000n, allowance: state.allowance,
        tradingOpen: state.open, tradingFallbackAt: state.fallbackAt,
      };
      assert.ok(p.functionName in values, p.functionName); return values[p.functionName];
    },
  } as unknown as RpcClient;
  const request = { marketId: id, tokenIn: addr(3), tokenOut: addr(5), amountIn: 1_000_000n, caller: addr(8) };
  return { state, request, sdk: createOxleyClient({ publicClient: rpc, deployment: manifest }) };
}
test("Gen2 trading status gates quotes and swaps until delivery completes or the fallback passes", async () => {
  const { state, request, sdk } = marketFixture(gen2);
  const closed = await sdk.getTradingStatus(id);
  assert.deepEqual([closed.open, closed.fallbackAt, closed.gated, closed.blockNumber], [false, 1500n, true, 100n]);
  const notOpen = (e: unknown) => code("TRADING_NOT_OPEN")(e) && (e as OxleyError).details?.fallbackAt === 1500n
    && /by 1970-01-01T00:25:00Z at the latest/.test((e as Error).message);
  await assert.rejects(sdk.prepareSwap({ ...request, slippageBps: 50 }), notOpen);
  await assert.rejects(sdk.quote(request), notOpen);
  assert.equal((await sdk.quoteMany([request])).results[0]?.status, "rejected");
  assert.ok(!state.reads.includes("quoteBuy"));
  state.open = true;
  assert.equal((await sdk.getTradingStatus(id)).open, true);
  const swap = await sdk.prepareSwap({ ...request, slippageBps: 50 });
  assert.equal(swap.quote.amountOut, 900_000n);
  state.open = false;
  await assert.rejects(sdk.checkSwap(swap), notOpen);
  state.timestamp = 1500n;
  await assert.rejects(sdk.getTradingStatus(id), code("INVALID_TRADING_GATE"));
});
test("flat-fee trading status is ungated and adds no gate reads to quotes", async () => {
  const { state, request, sdk } = marketFixture(flat);
  const status = await sdk.getTradingStatus(id);
  assert.deepEqual([status.open, status.fallbackAt, status.gated], [true, null, false]);
  assert.equal((await sdk.prepareSwap({ ...request, slippageBps: 50 })).quote.amountOut, 900_000n);
  assert.ok(!state.reads.some(f => f === "tradingOpen" || f === "tradingFallbackAt"));
});
