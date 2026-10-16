import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, maxUint256, toHex, zeroAddress, type Abi, type Hex } from "viem";
import { createOxleyLaunchClient, buildCreatorAccount, buildAuctionLaunch, quoteAuctionFloor,
  validateAuctionLaunch, parseLaunchDeployment, creatorAccountAbi, creatorAccountFactoryAbi,
  launchControllerAbi, launchFloorAbi, type AuctionLaunchInput, type LaunchRpcClient } from "../src/launch.js";
import { tokenAbi } from "../src/abis.js";

const addr = (n: number) => toHex(n, { size: 20 });
const id = toHex(1, { size: 32 }), owner = addr(9), account = addr(15), coin = addr(6), auction = addr(8);
const pin = (n: number) => ({ address: addr(n), runtimeCodeHash: keccak256("0x6000") });
const deployment = { schemaVersion: 1, releaseId: "test", chainId: 31337, network: "testnet", startBlock: "1",
  curve: pin(1), registry: pin(2), quoteToken: { ...pin(3), decimals: 6, symbol: "Oxy-USDC" }, auctionController: addr(4),
  auctionBindings: { controllerRuntimeCodeHash: keccak256("0x6000"), bidRouter: pin(5), adapter: pin(11) },
  launchBindings: { creatorAccountFactory: pin(12), entryController: pin(13), bondEscrow: pin(14),
    launchFeeBaseUnits: "1500000", deployerBondWei: "500000000000000000" } };
const input: AuctionLaunchInput = { owner, dealId: id, name: "SDK Launch", symbol: "SDK", floorPriceWad: 10n ** 19n,
  creatorLockDays: 30, listingCommitmentBps: 5000, auctionDurationHours: 1 };

function fixture() {
  const state = { chain: 31337, code: "0x6000" as Hex, reorg: false, old: false,
    account: zeroAddress as Hex, initial: owner, current: owner, beneficiary: owner, bondBeneficiary: owner, registered: true,
    launched: false, available: true, used: false, enabled: true, paused: false, badFloor: false,
    fee: 1_500_000n, deposit: 500_000_000_000_000_000n, native: 10n ** 18n, balance: 1_500_000n,
    allowance: 0n, gasPrice: 100n, pending: 0, confirmed: 0, nonceChanged: false, nonceReads: 0, timestamp: BigInt(Math.floor(Date.now() / 1000)),
    callError: false, callData: "0x" as Hex, calls: [] as Record<string, unknown>[], factory: addr(12), accountBond: addr(14) };
  const rpc = {
    getChainId: async () => state.chain,
    getBlock: async (args: { blockNumber?: bigint }) => ({ number: 100n,
      timestamp: state.timestamp - (state.old ? 1000n : 0n), hash: toHex(state.reorg && args.blockNumber !== undefined ? 2 : 1, { size: 32 }) }),
    getCode: async () => state.code,
    getBalance: async () => state.native,
    getGasPrice: async () => state.gasPrice,
    getTransactionCount: async (args: { blockTag: string }) => {
      state.nonceReads++;
      return args.blockTag === "pending" ? state.pending + (state.nonceChanged && state.nonceReads > 2 ? 1 : 0) : state.confirmed;
    },
    estimateGas: async () => 100_000n,
    readContract: async ({ address: target, functionName: f }: { address: string; functionName: string }) => {
      const floor = quoteAuctionFloor(input.floorPriceWad);
      const values: Record<string, unknown> = {
        feeBidRouter: addr(5), ccaAdapter: addr(11), quoteAsset: addr(3), registry: addr(2), adapter: addr(11),
        controller: target === account ? state.current : addr(4), validationHook: addr(7), decimals: 6,
        campaign: [account, coin, id, 200n, true],
        deal: { creator: state.launched || state.used ? account : zeroAddress, coin, controller: addr(4), reserveAsset: addr(3), profile: 1, status: 2 },
        auctionFor: auction, token: coin, currency: addr(3), creatorAccountFactory: state.factory, entryController: addr(13),
        bondEscrow: target === account ? state.accountBond : addr(14), auctionController: addr(4),
        launchFee: state.fee, CREATOR_DEPOSIT: state.deposit, MAX_GAS_PRICE: 1_000_000_000n, publicLaunchEnabled: state.enabled, entriesPaused: state.paused,
        accountFor: state.account, isAccount: state.registered, initialController: state.initial, bondBeneficiary: state.bondBeneficiary,
        beneficiary: state.beneficiary, dealId: id, launched: state.launched, coin,
        isTickerAvailable: state.available, effectiveFloor: [floor.floorPriceQ96 + (state.badFloor ? 1n : 0n), floor.tickSpacingQ96],
        balanceOf: state.balance, allowance: state.allowance,
      };
      assert.ok(f in values, f); return values[f];
    },
    call: async (args: Record<string, unknown>) => {
      state.calls.push(args); if (state.callError) throw new Error("contract revert"); return { data: state.callData };
    },
  } as unknown as LaunchRpcClient;
  return { state, rpc, client: createOxleyLaunchClient({ publicClient: rpc, deployment }) };
}

test("launch ABIs match retained compiler artifacts, including payable mutability and events", () => {
  const evidence = JSON.parse(readFileSync(new URL("../docs/launch-artifacts.json", import.meta.url), "utf8"));
  const subsets = [creatorAccountFactoryAbi, creatorAccountAbi];
  const shape = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shape);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([k, v]) => !["name", "internalType"].includes(k) && !(["indexed", "anonymous"].includes(k) && v === false))
      .map(([k, v]) => [k, shape(v)]));
    return value;
  };
  for (const [i, item] of evidence.evidence.entries()) {
    const raw = readFileSync(new URL(`../abis/${item.name}.json`, import.meta.url));
    const fixture = readFileSync(new URL(`fixtures/${item.name}.json`, import.meta.url));
    const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    assert.equal(sha(raw), item.abiSha256); assert.equal(sha(fixture), item.fixtureSha256);
    const full = JSON.parse(raw.toString()) as Abi;
    assert.deepEqual(full, JSON.parse(fixture.toString()).abi);
    for (const entry of subsets[i]!) assert.deepEqual(shape(entry), shape(full.find(candidate =>
      candidate.type === entry.type && "name" in candidate && candidate.name === entry.name)), entry.name);
  }
  for (const [subset, name] of [[launchControllerAbi, "ElysiumBondedCcaLaunchControllerVNext"], [launchFloorAbi, "ElysiumUniswapCcaAdapter"]] as const) {
    const full = JSON.parse(readFileSync(new URL(`../abis/${name}.json`, import.meta.url), "utf8"));
    for (const entry of subset) assert.deepEqual(shape(entry), shape(full.find((e: { name?: string }) => e.name === entry.name)), entry.name);
  }
});
test("unsigned setup preserves owner beneficiary; launch targets account with exact bond and launch terms", () => {
  const setup = buildCreatorAccount({ deployment, owner, dealId: id });
  assert.equal(setup.to, addr(12)); assert.equal(setup.value, 0n);
  assert.deepEqual(decodeFunctionData({ abi: creatorAccountFactoryAbi, data: setup.data }).args, [id, owner]);
  const launch = buildAuctionLaunch({ ...input, deployment, creatorAccount: account });
  assert.equal(launch.to, account); assert.equal(launch.value, 500_000_000_000_000_000n);
  const full = JSON.parse(readFileSync(new URL("../abis/ElysiumCreatorAccount.json", import.meta.url), "utf8"));
  assert.equal(launch.data, encodeFunctionData({ abi: full, functionName: "launchAuctionWithCommitmentAndDuration",
    args: [input.name, input.symbol, input.floorPriceWad, 30, 5000, 1] }));
});
test("launch validation rejects unsupported terms, precision mistakes and malformed identities", () => {
  for (const patch of [{ owner: zeroAddress }, { dealId: toHex(0, { size: 32 }) }, { name: " " }, { name: "a".repeat(81) },
    { name: "é".repeat(41) }, { symbol: "mixedCase" }, { symbol: "A".repeat(11) }, { creatorLockDays: 1 },
    { listingCommitmentBps: 0 }, { auctionDurationHours: 0 }, { auctionDurationHours: 25 }, { auctionDurationHours: 1.5 },
    { floorPriceWad: 0n }, { floorPriceWad: maxUint256 }, { floorPriceWad: 10 }, { floorPriceWad: "1000" }]) {
    assert.throws(() => validateAuctionLaunch({ ...input, ...patch } as AuctionLaunchInput));
  }
  assert.doesNotThrow(() => validateAuctionLaunch({ ...input, name: "é".repeat(40), creatorLockDays: 60,
    listingCommitmentBps: 10000, auctionDurationHours: 24 }));
  const floor = quoteAuctionFloor(input.floorPriceWad);
  assert.equal(floor.floorPriceQ96 % floor.tickSpacingQ96, 0n);
  assert.ok(floor.effectiveFloorPriceWad >= input.floorPriceWad);
});
test("manifest cannot silently omit launch pins or substitute fees, bonds or mainnet placeholders", () => {
  assert.throws(() => parseLaunchDeployment({ ...deployment, launchBindings: undefined }));
  for (const patch of [{ deployerBondWei: "1" }, { launchFeeBaseUnits: "-1" }, { launchFeeBaseUnits: 1500000 },
    { creatorAccountFactory: pin(3) }, { entryController: null }]) {
    assert.throws(() => parseLaunchDeployment({ ...deployment, launchBindings: { ...deployment.launchBindings, ...patch } }));
  }
  assert.throws(() => parseLaunchDeployment(JSON.parse(readFileSync(new URL("../deployments/mainnet.template.json", import.meta.url), "utf8"))));
  assert.ok(Object.isFrozen(parseLaunchDeployment(deployment).launchBindings.creatorAccountFactory));
  assert.equal(parseLaunchDeployment({ ...deployment, chainId: 12345, network: "mainnet",
    quoteToken: { ...deployment.quoteToken, symbol: "USDC" } }).quoteToken.symbol, "USDC");
});
test("prepare resumes setup -> approval -> launch -> complete without repeating successful steps", async () => {
  const { state, client } = fixture();
  assert.equal((await client.prepareLaunch(input)).stage, "setup");
  state.account = account;
  const approve = await client.prepareLaunch(input); assert.equal(approve.stage, "approve"); assert.ok(approve.transaction);
  assert.deepEqual(decodeFunctionData({ abi: tokenAbi, data: approve.transaction.data }).args, [getAddress(account), 1_500_000n]);
  state.allowance = 1_500_000n;
  const launch = await client.prepareLaunch(input); assert.equal(launch.stage, "launch");
  assert.equal(launch.transaction?.to, account); assert.equal(launch.transaction?.value, state.deposit);
  assert.equal(launch.transaction?.gasPrice, state.gasPrice);
  assert.equal(state.calls.at(-1)?.gasPrice, state.gasPrice);
  state.launched = true; state.available = false; state.balance = 0n; state.native = 0n; state.enabled = false;
  const complete = await client.prepareLaunch(input);
  assert.equal(complete.stage, "complete"); assert.equal(complete.transaction, null);
  assert.equal(complete.auction, auction); assert.equal(complete.coin, coin);
  assert.equal(state.calls.length, 3);
  state.current = addr(99); state.beneficiary = addr(99);
  assert.equal((await client.getLaunch({ owner, dealId: id })).launched, true);
});
test("insufficient nonzero allowance resets first and approved allowance is not increased", async () => {
  const { state, client } = fixture(); state.account = account; state.allowance = 1n;
  const reset = await client.prepareLaunch(input); assert.equal(reset.stage, "reset"); assert.ok(reset.transaction);
  assert.deepEqual(decodeFunctionData({ abi: tokenAbi, data: reset.transaction.data }).args, [getAddress(account), 0n]);
  state.allowance = maxUint256; assert.equal((await client.prepareLaunch(input)).stage, "launch");
});
test("on-chain costs, ownership, freshness, availability and pending transactions fail closed", async () => {
  const cases: [string, (s: ReturnType<typeof fixture>["state"]) => void][] = [
    ["CHAIN_MISMATCH", s => { s.chain = 1; }], ["CODE_MISMATCH", s => { s.code = "0x"; }],
    ["REORG", s => { s.reorg = true; }], ["STALE_BLOCK", s => { s.old = true; }],
    ["LAUNCH_BINDING_MISMATCH", s => { s.factory = addr(99); }], ["LAUNCH_COST_MISMATCH", s => { s.fee++; }],
    ["LAUNCH_COST_MISMATCH", s => { s.deposit++; }], ["LAUNCH_PAUSED", s => { s.enabled = false; }],
    ["LAUNCH_PAUSED", s => { s.paused = true; }], ["TICKER_UNAVAILABLE", s => { s.available = false; }],
    ["DEAL_ID_USED", s => { s.used = true; }], ["FLOOR_MISMATCH", s => { s.badFloor = true; }],
    ["INSUFFICIENT_QUOTE", s => { s.balance = 0n; }], ["INSUFFICIENT_BOND", s => { s.native = 0n; }],
    ["INSUFFICIENT_GAS", s => { s.native = s.deposit; }], ["PENDING_TRANSACTION", s => { s.pending = 1; }],
    ["NONCE_CHANGED", s => { s.nonceChanged = true; }],
    ["INVALID_GAS_PRICE", s => { s.gasPrice = 0n; }],
    ["GAS_PRICE_TOO_HIGH", s => { s.account = account; s.allowance = s.fee; s.gasPrice = 1_000_000_001n; }],
    ["INVALID_CREATOR_ACCOUNT", s => { s.account = account; s.registered = false; }],
    ["CREATOR_BINDING_MISMATCH", s => { s.account = account; s.initial = addr(99); }],
    ["CREATOR_BINDING_MISMATCH", s => { s.account = account; s.beneficiary = addr(99); }],
    ["CREATOR_BINDING_MISMATCH", s => { s.account = account; s.bondBeneficiary = addr(99); }],
    ["CREATOR_BINDING_MISMATCH", s => { s.account = account; s.accountBond = addr(99); }],
  ];
  for (const [code, mutate] of cases) {
    const { state, client } = fixture(); mutate(state);
    await assert.rejects(client.prepareLaunch(input), (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code, code);
  }
});
test("all prepared steps are simulated; false approvals and simulation reverts never yield transactions", async () => {
  const { state, client } = fixture(); state.callError = true;
  await assert.rejects(client.prepareLaunch(input), /contract revert/);
  state.callError = false; state.account = account; state.callData = toHex(0, { size: 32 });
  await assert.rejects(client.prepareLaunch(input), /approval returned/);
  state.callData = toHex(1, { size: 32 });
  const result = await client.prepareLaunch(input);
  assert.equal(result.stage, "approve"); assert.ok("simulated" in result && result.simulated);
  assert.ok("expiresAt" in result && result.expiresAt === state.timestamp + 120n);
});
