import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { createOxleyAuctionClient } from "../src/auctions.js";
import { createOxleyLaunchClient, creatorAccountAbi, creatorAccountFactoryAbi, launchBondAbi, launchControllerAbi, launchDealId, launchFloorAbi, minimumRaiseFloor, newDraftSalt,
  quoteAuctionFloor, validateLaunchFloor, SCHEDULE_EXECUTION_WINDOW_SECONDS, SCHEDULE_HOLD_COOLDOWN_SECONDS, SCHEDULE_MAX_LEAD_SECONDS, SCHEDULE_MIN_LEAD_SECONDS,
  SCHEDULED_EXECUTION_GAS_CAP, SCHEDULED_EXECUTION_MAX_GAS_PRICE } from "../src/launch.js";
import { PUBLICATION_PURPOSE, publicationTypedData } from "../src/metadata.js";
import { OxleyError } from "../src/index.js";

// Read-only: the launch floor rules checked against the live adapter and controller, and the launch client against the live launch graph; no signer, no transaction.
const deployment = JSON.parse(readFileSync(new URL("../deployments/elysium-testnet.json", import.meta.url), "utf8"));
let nextRequest = 0;
const pacedFetch: typeof fetch = async (input, init) => {
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Date.now() + wait + 550;
  await delay(wait);
  return fetch(input, init);
};
const publicClient = createPublicClient({ transport: http(process.env.OXLEY_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz",
  { timeout: 30_000, retryCount: 1, fetchFn: pacedFetch }) });
// Verification reads the controller's floor cap and its 30,000 USDC net minimum raise.
const verified = await createOxleyAuctionClient({ publicClient, deployment }).verifyDeployment();
const lowest = minimumRaiseFloor();
for (const price of [9_959_120_000_000_000_000n, 10n ** 19n, 10n ** 20n, lowest, lowest - 1n, 10n ** 21n]) {
  const expected = quoteAuctionFloor(price);
  const actual = await publicClient.readContract({ address: deployment.auctionBindings.adapter.address, abi: launchFloorAbi,
    functionName: "effectiveFloor", args: [price], blockNumber: verified.blockNumber });
  assert.deepEqual(actual, [expected.floorPriceQ96, expected.tickSpacingQ96]);
}
assert.doesNotThrow(() => validateLaunchFloor(lowest));
assert.throws(() => validateLaunchFloor(lowest - 1n));
// The launch client: the whole launch graph verified at one block, then a launch prepared for a wallet that holds nothing. Every chain read the preparation makes (deal id,
// creator account, ticker, deal, effective floor, terms) must succeed before it reaches the balance check and refuses with INSUFFICIENT_QUOTE.
const launches = createOxleyLaunchClient({ publicClient, deployment });
const launchGraph = await launches.verifyDeployment();
assert.deepEqual([launchGraph.launchFee, launchGraph.deployerBondWei], [1_500_000n, 500_000_000_000_000_000n]);
const controller = deployment.auctionController as Address;
const namespace = await publicClient.readContract({ address: controller, abi: parseAbi(["function LAUNCH_NAMESPACE() view returns (bytes32)"]), functionName: "LAUNCH_NAMESPACE", blockNumber: launchGraph.blockNumber });
assert.equal(namespace, "0x265ed5d0ea8ae47c1971c5643a4c5aabbe305fb04094380952a15d2c460b2ed8");
const probe = { owner: "0x00000000000000000000000000000000000c0de1", draftSalt: newDraftSalt(), name: "Probe Coin", symbol: "ZZPROBE1", floorPriceWad: lowest,
  creatorLockDays: 0, listingCommitmentBps: 0, auctionDurationHours: 1, secondsPerBlock: 0.16 } as const;
const derived = await publicClient.readContract({ address: controller, abi: parseAbi(["function dealIdFor(address,bytes32) view returns (bytes32)"]), functionName: "dealIdFor",
  args: [probe.owner, probe.draftSalt], blockNumber: launchGraph.blockNumber });
assert.equal(derived, launchDealId({ chainId: deployment.chainId, controller, owner: probe.owner, draftSalt: probe.draftSalt }));
await assert.rejects(launches.prepareLaunch(probe), (error: unknown) => error instanceof OxleyError && error.code === "INSUFFICIENT_QUOTE");
// Creator accounts: the newest few the factory created, read by address. Their scheduling constants are the SDK's, the controller's ticker cooldown and the bond escrow's repayment
// of an execution are too, and the schedule, bond and fee reads run against them. Nothing is sent; no account's salt or owner is needed.
const factory = deployment.launchBindings.creatorAccountFactory.address as Address, escrow = deployment.launchBindings.bondEscrow.address as Address;
const created = creatorAccountFactoryAbi.find((item): item is Extract<typeof item, { type: "event" }> => item.type === "event")!;
const accounts: Address[] = [];
for (let to = launchGraph.blockNumber, chunks = 0; accounts.length < 3 && chunks < 80 && to > BigInt(deployment.startBlock); to -= 10_000n, chunks++) {
  const logs = await publicClient.getLogs({ address: factory, event: created, fromBlock: to - 9_999n, toBlock: to });
  for (const log of [...logs].reverse()) if (accounts.length < 3) accounts.push(log.args.account!);
}
assert.ok(accounts.length > 0, "the factory has created creator accounts");
const at = { blockNumber: launchGraph.blockNumber };
const onAccount = (address: Address, functionName: "SCHEDULED_BOND" | "MIN_LEAD" | "MAX_LEAD" | "EXECUTION_WINDOW" | "MAX_NAME_BYTES" | "MAX_SIMULATED_GAS" | "handoverCount" | "feeRouter") =>
  publicClient.readContract({ address, abi: creatorAccountAbi, functionName, ...at });
const [bondConstant, minLead, maxLead, window, nameBytes, simulatedGas, cooldown, repaidGas, escrowGasPrice] = await Promise.all([onAccount(accounts[0]!, "SCHEDULED_BOND"), onAccount(accounts[0]!, "MIN_LEAD"),
  onAccount(accounts[0]!, "MAX_LEAD"), onAccount(accounts[0]!, "EXECUTION_WINDOW"), onAccount(accounts[0]!, "MAX_NAME_BYTES"), onAccount(accounts[0]!, "MAX_SIMULATED_GAS"),
  publicClient.readContract({ address: controller, abi: launchControllerAbi, functionName: "HOLD_COOLDOWN", ...at }),
  publicClient.readContract({ address: escrow, abi: launchBondAbi, functionName: "SCHEDULED_LAUNCH_GAS", ...at }), publicClient.readContract({ address: escrow, abi: launchBondAbi, functionName: "MAX_GAS_PRICE", ...at })]);
assert.deepEqual([bondConstant, BigInt(minLead), BigInt(maxLead), BigInt(window), nameBytes, simulatedGas, cooldown, repaidGas, escrowGasPrice],
  [BigInt(deployment.launchBindings.deployerBondWei), BigInt(SCHEDULE_MIN_LEAD_SECONDS), BigInt(SCHEDULE_MAX_LEAD_SECONDS), BigInt(SCHEDULE_EXECUTION_WINDOW_SECONDS), 80n, 10_000_000n,
    BigInt(SCHEDULE_HOLD_COOLDOWN_SECONDS), SCHEDULED_EXECUTION_GAS_CAP, SCHEDULED_EXECUTION_MAX_GAS_PRICE]);
// The publication domain a creator account verifies is the one the metadata client signs for: OpenZeppelin's eip712Domain() of a live account.
const domainAbi = parseAbi(["function eip712Domain() view returns (bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)"]);
const domain = await publicClient.readContract({ address: accounts[0]!, abi: domainAbi, functionName: "eip712Domain", ...at });
const typed = publicationTypedData({ creatorAccount: accounts[0]!, purpose: "metadata", message: "probe", epoch: 0n, issuedAt: 1 });
assert.deepEqual([domain[1], domain[2], domain[3], domain[4].toLowerCase()], [typed.domain.name, typed.domain.version, typed.domain.chainId, accounts[0]!.toLowerCase()]);
const metadataPurpose = await publicClient.readContract({ address: accounts[0]!, abi: parseAbi(["function METADATA_PUBLICATION() view returns (bytes32)", "function IMAGE_PUBLICATION() view returns (bytes32)"]), functionName: "METADATA_PUBLICATION", ...at });
assert.equal(metadataPurpose, PUBLICATION_PURPOSE.metadata);
const reads = [];
for (const creatorAccount of accounts) {
  const [schedule, bond, fees] = await Promise.all([launches.getScheduledLaunch({ creatorAccount }), launches.getBondRefund({ creatorAccount }), launches.getCreatorFees({ creatorAccount })]);
  reads.push({ creatorAccount, launched: schedule.launched, phase: schedule.phase, scheduledStart: schedule.startTime, bond: { reason: bond.reason, refundableWei: bond.refundable, escrow: bond.escrow },
    fees: { reason: fees.reason, pending: fees.pending, active: fees.active, unlockAt: fees.unlockAt }, handoverCount: await onAccount(creatorAccount, "handoverCount") });
}
// Scheduling for a wallet that holds nothing: the ticker hold, the cooldown and the schedule's start are read and checked before the balance check refuses it.
const start = Math.floor(Date.now() / 1000) + 2 * 3600;
await assert.rejects(launches.prepareScheduledLaunch({ ...probe, startTime: start }), (error: unknown) => error instanceof OxleyError && error.code === "INSUFFICIENT_QUOTE");
// An existing launch can be read back by its creator and salt: OXLEY_LAUNCH_OWNER and OXLEY_LAUNCH_SALT.
const owner = process.env.OXLEY_LAUNCH_OWNER as Address | undefined, draftSalt = process.env.OXLEY_LAUNCH_SALT as `0x${string}` | undefined;
const readBack = owner && draftSalt ? await launches.getLaunch({ owner, draftSalt }) : null;
console.log(JSON.stringify({ version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  chainId: deployment.chainId, readOnly: true, runtimePinsMatch: true, minimumRaiseFloor: lowest, blockNumber: verified.blockNumber,
  blockHash: verified.blockHash, floorSamplesMatch: 6,
  launch: { blockNumber: launchGraph.blockNumber, launchFee: launchGraph.launchFee, deployerBondWei: launchGraph.deployerBondWei, maxLaunchGasPrice: launchGraph.maxLaunchGasPrice,
    publicLaunchEnabled: launchGraph.publicLaunchEnabled, entriesPaused: launchGraph.entriesPaused, namespaceMatches: true, dealIdMatches: true, unfundedWalletRefused: "INSUFFICIENT_QUOTE",
    readBack: readBack && { creatorAccount: readBack.creatorAccount, launched: readBack.launched, coin: readBack.coin, auction: readBack.launch?.auction ?? null } },
  creator: { accountsRead: reads.length, scheduleConstantsMatch: true, holdCooldownMatches: true, escrowRepaymentMatches: true, publicationDomainMatches: true, unfundedScheduleRefused: "INSUFFICIENT_QUOTE", reads } },
(_, v) => typeof v === "bigint" ? v.toString() : v));
