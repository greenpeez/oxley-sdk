import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { MANIFEST } from "./deployment-manifests.mjs";

// Exercise the actual archive from an unrelated project, not a workspace symlink.
const root = process.cwd();
const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" });
const [pack] = JSON.parse(output);
const packed = path => pack.files.some(file => file.path === path);
for (const path of ["dist/index.js", "dist/index.d.ts", "dist/data.d.ts", "dist/auctions.d.ts", "dist/launch.d.ts", "dist/metadata.d.ts", "dist/abis.d.ts", "dist/zero-ex.d.ts",
  "docs/data-api.md", "docs/auctions.md", "docs/launch.md", "docs/creator.md", "docs/markets.md", "docs/integrator-fees.md", "docs/mainnet.md", "docs/live-artifacts.json",
  MANIFEST.file, "deployments/mainnet.template.json", "abis/curve.json", "abis/bid-router.json", "abis/bid-hook.json", "abis/terms-registry.json",
  "abis/cca-auction.json", "abis/auction-controller.json", "abis/adapter.json", "abis/registry.json", "abis/exposure-helper.json", "abis/creator-account.json",
  "abis/creator-account-factory.json", "abis/bond-escrow.json", "abis/entry-controller.json", "abis/fee-router.json", "examples/dynamic-bid.ts", "examples/integrator-fee.ts",
  "examples/launch.ts", "examples/launch-floor.ts", "examples/scheduled-launch.ts", "examples/creator.ts", "examples/token-metadata.ts"]) assert.ok(packed(path), path);
for (const file of pack.files) {
  assert.ok(/^(dist\/|abis\/|docs\/|deployments\/|examples\/|README\.md$|LICENSE$|package\.json$)/.test(file.path), file.path);
  assert.ok(!/(\.env|node_modules|test\/|fixtures|\.log$|private.key)/i.test(file.path), file.path);
  // Nothing in the archive belongs to a contract release other than the one this package supports.
  assert.ok(!/(gen[2389]\b|gen[2389][-_.]|flat-fee|VNext|ElysiumReserveCurve|ElysiumCurveGen)/i.test(file.path), file.path);
}
const directory = mkdtempSync(join(tmpdir(), "oxley-sdk-consumer-"));
try {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(root, pack.filename)],
    { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "consumer.mjs"), `
    import assert from 'node:assert/strict';
    import { encodeErrorResult } from 'viem';
    import * as sdk from '@oxley/sdk';
    import * as abis from '@oxley/sdk/abis';
    import * as auctions from '@oxley/sdk/auctions';
    import * as launch from '@oxley/sdk/launch';
    import * as metadata from '@oxley/sdk/metadata';
    import * as zeroEx from '@oxley/sdk/0x';
    import * as data from '@oxley/sdk/data';
    import deployment from '@oxley/sdk/deployments/elysium-testnet.json' with { type: 'json' };
    import template from '@oxley/sdk/deployments/mainnet.template.json' with { type: 'json' };
    import curveAbi from '@oxley/sdk/abis/curve.json' with { type: 'json' };
    import bidRouterAbi from '@oxley/sdk/abis/bid-router.json' with { type: 'json' };
    import bidHookAbi from '@oxley/sdk/abis/bid-hook.json' with { type: 'json' };
    import termsAbi from '@oxley/sdk/abis/terms-registry.json' with { type: 'json' };
    import ccaAbi from '@oxley/sdk/abis/cca-auction.json' with { type: 'json' };
    import controllerAbi from '@oxley/sdk/abis/auction-controller.json' with { type: 'json' };
    import adapterAbi from '@oxley/sdk/abis/adapter.json' with { type: 'json' };
    import registryAbi from '@oxley/sdk/abis/registry.json' with { type: 'json' };
    import exposureAbi from '@oxley/sdk/abis/exposure-helper.json' with { type: 'json' };
    import creatorAccountAbi from '@oxley/sdk/abis/creator-account.json' with { type: 'json' };
    import factoryAbi from '@oxley/sdk/abis/creator-account-factory.json' with { type: 'json' };
    import bondEscrowAbi from '@oxley/sdk/abis/bond-escrow.json' with { type: 'json' };
    import entryAbi from '@oxley/sdk/abis/entry-controller.json' with { type: 'json' };
    import feeRouterAbi from '@oxley/sdk/abis/fee-router.json' with { type: 'json' };
    // The exact value-export surface of every entry point: an addition or a removal fails this check.
    const names = module => Object.keys(module).sort();
    assert.deepEqual(names(sdk), ${JSON.stringify([
      "MAX_FLOOR_PRICE_WAD", "MAX_INTEGRATOR_FEE_BPS", "MINIMUM_GROSS_RAISE", "MINIMUM_NET_RAISE", "OPENING_SURCHARGE_SECONDS", "OPENING_SURCHARGE_START_WAD",
      "OxleyError", "SEQUENTIAL_FEE_WARNING", "STANDARD_TRADING_FEE_BPS", "buildAcceptTerms", "buildApprovals", "buildSwap", "buildSwapWithFee", "buyFeeBps",
      "createOxleyClient", "curveAbi", "decodeOxleyRevert", "eip5792Batch", "integratorFeeAmount", "launchFloorCapAbi", "launchMinimumRaiseAbi", "minimumAmountOut",
      "openingFeeCurveAbi", "openingSurchargeAmount", "openingSurchargeWadAt", "parseDeployment", "registryAbi", "termsRegistryAbi", "testnetDeployment", "tokenAbi",
      "tradingGateAbi", "validMarketCapitalization", "validMarketObservationFields", "validMarketProtocolObservation"])});
    assert.deepEqual(names(abis), ${JSON.stringify([
      "auctionAdapterAbi", "auctionBidRouterAbi", "auctionControllerAbi", "bidHookAbi", "ccaAuctionAbi", "ccaCheckpointAbi", "creatorAccountAbi", "creatorAccountFactoryAbi",
      "creatorFeeRouterAbi", "curveAbi", "launchBondAbi", "launchControllerAbi", "launchEntryAbi", "launchFloorAbi", "launchFloorCapAbi", "launchMinimumRaiseAbi", "openingFeeCurveAbi",
      "oxleyRevertAbi", "registryAbi", "termsRegistryAbi", "tokenAbi", "tradingGateAbi"])});
    assert.deepEqual(names(auctions), ${JSON.stringify([
      "ACCEPTED_BID_FEE_BPS", "BID_RULES", "MAX_FLOOR_PRICE_WAD", "MAX_LIVE_BIDS", "MAX_PRICE_LEVELS", "MAX_WALLET_BIDS", "MINIMUM_GROSS_RAISE", "MINIMUM_NET_RAISE",
      "MIN_BID", "TOKEN_CAP", "acceptedBidFee", "affordableBid", "alignBidPrice", "auctionAdapterAbi", "auctionBidRouterAbi", "auctionControllerAbi", "bidDebit",
      "bidHookAbi", "bidRefusal", "bidsRemaining", "buildAuctionBidApprovals", "buildAuctionClaim", "buildAuctionRefund", "buildDynamicBid", "buildDynamicRebid",
      "ccaAuctionAbi", "ccaCheckpointAbi", "createOxleyAuctionClient", "decodeBidWitnesses", "decodeOxleyRevert", "encodeBidWitnesses", "launchFloorAbi",
      "launchFloorCapAbi", "launchMinimumRaiseAbi", "liveBids", "maximumNewBid", "normalizeCheckpoints", "oxleyRevertAbi", "walletAllowance", "walletCeiling",
      "witnessFor"])});
    assert.deepEqual(names(launch), ${JSON.stringify([
      "AUCTION_MAX_BLOCKS_PER_HOUR", "AUCTION_MIN_BLOCKS_PER_HOUR", "BLOCK_RATE_SAMPLE_BLOCKS", "MAX_FLOOR_PRICE_WAD", "MINIMUM_GROSS_RAISE", "MINIMUM_NET_RAISE", "OFFERED_UNITS",
      "SCHEDULED_EXECUTION_GAS_CAP", "SCHEDULED_EXECUTION_MAX_GAS_PRICE", "SCHEDULE_EXECUTION_WINDOW_SECONDS", "SCHEDULE_HOLD_COOLDOWN_SECONDS", "SCHEDULE_MAX_LEAD_SECONDS",
      "SCHEDULE_MIN_LEAD_SECONDS", "auctionDurationBlocks", "auctionDurationBounds", "buildAcceptTerms", "buildAuctionLaunch", "buildClaimBondRefund", "buildClaimCreatorFees",
      "buildClaimScheduledFee", "buildCreatorAccount", "buildExecuteScheduledLaunch", "buildLaunchApprovals", "buildRefundScheduledLaunch", "buildScheduleAuctionLaunch",
      "createOxleyLaunchClient", "creatorAccountAbi", "creatorAccountFactoryAbi", "creatorFeeRouterAbi", "decodeOxleyRevert", "floorReachesMinimumRaise", "launchBondAbi",
      "launchControllerAbi", "launchDealId", "launchEntryAbi", "launchFloorAbi", "launchFloorCapAbi", "launchMinimumRaiseAbi", "minimumRaiseFloor", "newDraftSalt",
      "parseLaunchDeployment", "quoteAuctionFloor", "sampleSecondsPerBlock", "scheduleStartBounds", "scheduledPhase", "tickerCooldownEnd", "tickerKey", "validateAuctionLaunch",
      "validateLaunchFloor", "validateScheduleStart"])});
    assert.deepEqual(names(metadata), ${JSON.stringify([
      "IMAGE_SIGNATURE_MAX_AGE_SECONDS", "METADATA_SIGNATURE_MAX_AGE_SECONDS", "OXLEY_APP_URL", "PUBLICATION_DEADLINE_SECONDS", "PUBLICATION_PURPOSE", "TOKEN_DESCRIPTION_MAX",
      "TOKEN_IMAGE_MAX_BODY", "TOKEN_IMAGE_MAX_BYTES", "TOKEN_IMAGE_MAX_PIXELS", "TOKEN_LINK_MAX", "TOKEN_METADATA_BATCH", "TOKEN_METADATA_CHAIN", "TOKEN_METADATA_MAX_BODY",
      "createOxleyMetadataClient", "emptyTokenMetadata", "inspectTokenImage", "normalizePublicationSignature", "parseTokenImageIntent", "parseTokenMetadataFields",
      "parseTokenMetadataIntent", "publicationTypedData", "tokenImageCid", "tokenImageMessage", "tokenMetadataHash", "tokenMetadataMessage", "validTokenMetadataRecord",
      "validateTokenImage"])});
    assert.deepEqual(names(zeroEx), ['buildZeroExBasic', 'zeroExBasicAbi']);
    assert.deepEqual(names(data), ['DataApiError', 'createOxleyDataClient', 'isCurrentData']);

    // The bundled testnet deployment is the reviewed one, parses, and is the embedded export.
    const parsed = sdk.parseDeployment(deployment);
    assert.equal(parsed.chainId, 99801); assert.equal(parsed.releaseId, ${JSON.stringify("elysium-auctions-gen10-1fa4ef2a98fd14ed")});
    assert.deepEqual(sdk.testnetDeployment, deployment);
    assert.equal(parsed.termsRegistry.address, '0x94c8c7203e2a01e37f104fa6cbe00382642c084d');
    assert.equal(parsed.auctionBindings.bidHook.address, '0x86f87064955204e52ad3925c9412b3a5cd07e061');
    assert.equal(parsed.launchBindings.creatorAccountFactory.address, '0x343ce625f9930648ccebe503bd274606b376d98c');
    assert.deepEqual([parsed.launchBindings.launchFeeBaseUnits, parsed.launchBindings.deployerBondWei], ['1500000', '500000000000000000']);
    assert.deepEqual(parsed.bidRules, auctions.BID_RULES); assert.equal(auctions.BID_RULES.minBid, '20000000');
    assert.throws(() => sdk.parseDeployment(template));
    // The Gen10 rules: a 30,000 USDC net minimum raise (30,303,030,303 gross), a 1e21 floor cap, and the floor rule that follows.
    assert.deepEqual([sdk.MINIMUM_NET_RAISE, sdk.MINIMUM_GROSS_RAISE, sdk.MAX_FLOOR_PRICE_WAD], [30000000000n, 30303030303n, 10n ** 21n]);
    assert.equal(launch.minimumRaiseFloor(), 101010101030162826490n);
    assert.ok(launch.floorReachesMinimumRaise(110000000000000000000n) && !launch.floorReachesMinimumRaise(100000000000000000000n));
    assert.doesNotThrow(() => launch.validateLaunchFloor(110000000000000000000n)); assert.throws(() => launch.validateLaunchFloor(100000000000000000000n), /minimum raise/);
    assert.ok(launch.quoteAuctionFloor(110000000000000000000n).floorPriceQ96 > 0n);
    assert.equal(sdk.decodeOxleyRevert(encodeErrorResult({ abi: abis.launchFloorCapAbi, errorName: 'FloorPriceAboveMaximum', args: [10n ** 21n + 1n, 10n ** 21n] }))?.name, 'FloorPriceAboveMaximum');
    // Launch: the client takes the bundled manifest, derives the deal id and encodes the first step (the factory's createAccountForDraft) with no value.
    const salt = launch.newDraftSalt();
    assert.match(salt, /^0x[0-9a-f]{64}$/); assert.match(launch.launchDealId({ chainId: 99801, controller: parsed.auctionController, owner: '0x00000000000000000000000000000000000c0de1', draftSalt: salt }), /^0x[0-9a-f]{64}$/);
    const setup = launch.buildCreatorAccount({ chainId: 99801, factory: parsed.launchBindings.creatorAccountFactory.address, draftSalt: salt, beneficiary: '0x00000000000000000000000000000000000c0de1' });
    assert.equal(setup.to, parsed.launchBindings.creatorAccountFactory.address); assert.equal(setup.value, 0n); assert.equal(setup.data.slice(0, 10), '0xa178a9a0');
    assert.ok(launch.createOxleyLaunchClient({ publicClient: {}, deployment }).prepareLaunch);
    // launchBindings are optional for the manifest and required by the launch client alone.
    const { launchBindings: omitted, ...withoutBindings } = deployment;
    assert.equal('launchBindings' in sdk.parseDeployment(withoutBindings), false);
    assert.throws(() => launch.createOxleyLaunchClient({ publicClient: {}, deployment: withoutBindings }), error => error.code === 'LAUNCH_BINDINGS_REQUIRED');
    assert.throws(() => sdk.parseDeployment({ ...deployment, launchBindings: { ...omitted, deployerBondWei: '1' } }), error => error.code === 'INVALID_BOND');
    // Scheduled launches and creator claims: the account's own calldata, the schedule rules and the client's calls.
    const account = '0x00000000000000000000000000000000000c0de2', now = 1_800_000_000;
    const terms = { chainId: 99801, creatorAccount: account, name: 'Example', symbol: 'EXAMPLE', floorPriceWad: 110000000000000000000n, creatorLockDays: 30, listingCommitmentBps: 5000,
      auctionDurationHours: 1, durationBlocks: 22500, startTime: now + 7200, bondWei: 500000000000000000n, now };
    const scheduled = launch.buildScheduleAuctionLaunch(terms);
    assert.deepEqual([scheduled.to, scheduled.value, scheduled.data.slice(0, 10)], [account, 500000000000000000n, '0x105cd753']);
    assert.equal(launch.buildExecuteScheduledLaunch({ chainId: 99801, creatorAccount: account }).data, '0x1b6956a1');
    assert.deepEqual([launch.buildRefundScheduledLaunch({ chainId: 99801, creatorAccount: account }).data, launch.buildClaimScheduledFee({ chainId: 99801, creatorAccount: account }).data], ['0x060dfa91', '0xbe6e9881']);
    assert.equal(launch.buildClaimBondRefund({ chainId: 99801, creatorAccount: account, recipient: '0x00000000000000000000000000000000000c0de1' }).data.slice(0, 10), '0x79b7a49e');
    assert.equal(launch.buildClaimCreatorFees({ chainId: 99801, creatorAccount: account, recipient: '0x00000000000000000000000000000000000c0de1' }).data.slice(0, 10), '0x15a0ea6a');
    assert.throws(() => launch.validateScheduleStart(now + 60, now), error => error.code === 'LAUNCH_START_TOO_SOON');
    assert.deepEqual(launch.scheduleStartBounds(now), { earliest: now + 1080, latest: now + 8 * 86400 - 3600 });
    assert.equal(launch.scheduledPhase({ launched: false, scheduledStart: 1000n, bondRefundable: 0n }, 1000 + 86400), 'executable');
    assert.equal(launch.scheduledPhase({ launched: false, scheduledStart: 1000n, bondRefundable: 0n }, 1000 + 86401), 'expired');
    for (const method of ['getScheduledLaunch', 'prepareScheduledLaunch', 'prepareExecuteScheduledLaunch', 'prepareRefundScheduledLaunch', 'prepareClaimScheduledFee', 'getBondRefund',
      'prepareBondRefundClaim', 'getCreatorFees', 'prepareCreatorFeeClaim']) assert.equal(typeof launch.createOxleyLaunchClient({ publicClient: {}, deployment })[method], 'function', method);
    // Token details: the EIP-712 data the creator account verifies, built from the application's message.
    const typed = metadata.publicationTypedData({ creatorAccount: account, purpose: 'metadata', message: 'x', epoch: 0n, issuedAt: 1000 });
    assert.deepEqual([typed.domain.name, typed.domain.version, typed.domain.chainId, typed.message.deadline], ['OxleyCreatorPublication', '8', 99801n, 1600n]);
    assert.equal(metadata.tokenMetadataHash(metadata.emptyTokenMetadata()).length, 64);
    assert.equal(metadata.createOxleyMetadataClient().origin, 'https://app.oxley.fun');
    assert.deepEqual([launch.auctionDurationBounds(1).minimumBlocks, launch.auctionDurationBounds(1).maximumBlocks], [14400, 72000]);
    // Trading, fees, terms and the opening surcharge.
    assert.equal(sdk.minimumAmountOut(1000000n, 50), 995000n);
    assert.equal(sdk.integratorFeeAmount(10000000n, 50), 50000n); assert.equal(sdk.MAX_INTEGRATOR_FEE_BPS, 100);
    assert.equal(sdk.openingSurchargeWadAt(45), 8437500000000000n);
    assert.ok(sdk.createOxleyClient && sdk.buildAcceptTerms && sdk.buildSwapWithFee && zeroEx.buildZeroExBasic);
    // Auctions: Dynamic Bids and rebids, claims and refunds.
    assert.ok(auctions.createOxleyAuctionClient && auctions.buildDynamicBid && auctions.buildDynamicRebid && auctions.buildAuctionClaim && auctions.buildAuctionRefund);
    assert.equal(auctions.MIN_BID, 20000000n);
    // Data client.
    assert.equal(typeof data.createOxleyDataClient({ baseUrl: 'https://example.com/api/data/v1', chainId: 99801 }).tokens, 'function');
    assert.equal(data.isCurrentData({ checkedAt: 0, freshness: 'fresh' }), false);
    // Full compiler ABIs.
    assert.ok([curveAbi, bidRouterAbi, bidHookAbi, termsAbi, ccaAbi, controllerAbi, adapterAbi, registryAbi, exposureAbi, creatorAccountAbi, factoryAbi, bondEscrowAbi, entryAbi, feeRouterAbi].every(abi => abi.length));
    assert.ok(feeRouterAbi.some(entry => entry.name === 'dealConfig') && creatorAccountAbi.some(entry => entry.name === 'scheduleAuctionLaunch'));
    assert.ok(abis.curveAbi.length && abis.bidHookAbi.length && abis.termsRegistryAbi.length && abis.creatorAccountAbi.length && abis.launchControllerAbi.length);
    assert.ok(factoryAbi.some(entry => entry.name === 'createAccountForDraft') && creatorAccountAbi.some(entry => entry.name === 'launchAuctionWithCommitmentAndExactDuration'));
  `);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "consumer.ts"), `
    import { createOxleyClient, testnetDeployment, type Deployment, type QuoteRequest, type Swap, type SwapWithFee, type TermsStatus } from '@oxley/sdk';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, type IndexedData, type IndexedTrade, type TokenInfo } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, type DynamicBidLimits, type DynamicBidRequest, type PartialFillHints } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, quoteAuctionFloor, validateLaunchFloor, type AuctionLaunchInput, type ScheduledLaunchInput, type ScheduledLaunchInfo, type ScheduledPhase,
      type BondRefundReason, type CreatorFeesReason } from '@oxley/sdk/launch';
    import { createOxleyMetadataClient, type PreparedMetadataPublication, type TokenMetadataFields } from '@oxley/sdk/metadata';
    import { decodeOxleyRevert, type OxleyRevert } from '@oxley/sdk';
    import { createPublicClient, http } from 'viem';
    const publicClient = createPublicClient({ transport: http('http://localhost:8545') });
    export const client = (deployment: Deployment) => createOxleyClient({ deployment, publicClient });
    export const bundled = createOxleyClient({ deployment: testnetDeployment, publicClient });
    export const encode = (swap: Swap) => buildZeroExBasic(swap);
    export type Input = QuoteRequest;
    export const auctions = (deployment: unknown) => createOxleyAuctionClient({ deployment, publicClient });
    export const limits = (deployment: unknown, dealId: \`0x\${string}\`, owner: \`0x\${string}\`): Promise<DynamicBidLimits> =>
      createOxleyAuctionClient({ deployment, publicClient }).getDynamicBidLimits({ dealId, owner });
    export const bid = (deployment: unknown, request: DynamicBidRequest) => createOxleyAuctionClient({ deployment, publicClient }).prepareDynamicBid(request);
    export const refund = (deployment: unknown, dealId: \`0x\${string}\`, caller: \`0x\${string}\`, partialFill?: PartialFillHints) =>
      createOxleyAuctionClient({ deployment, publicClient }).prepareRefund({ dealId, bidId: 0n, caller, partialFill });
    export const floor = (price: bigint) => { validateLaunchFloor(price); return quoteAuctionFloor(price); };
    export const launches = (deployment: unknown) => createOxleyLaunchClient({ deployment, publicClient });
    export const nextStep = async (deployment: unknown, input: AuctionLaunchInput) => (await launches(deployment).prepareLaunch(input)).stage;
    export const scheduleStep = async (deployment: unknown, input: ScheduledLaunchInput) => (await launches(deployment).prepareScheduledLaunch(input)).stage;
    export const schedule = (deployment: unknown, owner: \`0x\${string}\`, draftSalt: \`0x\${string}\`): Promise<ScheduledLaunchInfo> => launches(deployment).getScheduledLaunch({ owner, draftSalt });
    export const phase = async (deployment: unknown, owner: \`0x\${string}\`, draftSalt: \`0x\${string}\`): Promise<ScheduledPhase> => (await schedule(deployment, owner, draftSalt)).phase;
    export const claimable = async (deployment: unknown, owner: \`0x\${string}\`, draftSalt: \`0x\${string}\`): Promise<[BondRefundReason, CreatorFeesReason]> =>
      [(await launches(deployment).getBondRefund({ owner, draftSalt })).reason, (await launches(deployment).getCreatorFees({ owner, draftSalt })).reason];
    export const details = createOxleyMetadataClient();
    export const publication = (input: Parameters<typeof details.prepareMetadataPublication>[0]): Promise<PreparedMetadataPublication> => details.prepareMetadataPublication(input);
    export const fields: TokenMetadataFields = { description: '', website: '', x: '', telegram: '' };
    export const reason = (error: unknown): OxleyRevert | null => decodeOxleyRevert(error, { quoteSymbol: 'USDC' });
    export const withFee = (request: Parameters<typeof bundled.prepareSwapWithFee>[0]): Promise<SwapWithFee> => bundled.prepareSwapWithFee(request);
    export const terms = (account: \`0x\${string}\`): Promise<TermsStatus> => bundled.getTermsStatus(account);
    export const data = createOxleyDataClient({ baseUrl: 'https://example.com/api/data/v1', chainId: 99801 });
    export const trades: (id: \`0x\${string}\`) => Promise<IndexedData<IndexedTrade>> =
      dealId => data.trades({ dealId, from: 100, to: 200 });
    export const tokens: (ids: string[]) => Promise<IndexedData<TokenInfo>> = ids => data.tokens({ ids });
  `);
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.ts"],
  { cwd: directory, stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(join(directory, "node_modules/@oxley/sdk/package.json")));
  assert.ok(!JSON.stringify(manifest.dependencies).includes("workspace:"));
  console.log(JSON.stringify({ filename: pack.filename, size: pack.size, unpackedSize: pack.unpackedSize,
    files: pack.files.length, integrity: pack.integrity, cleanConsumerImport: true, cleanConsumerTypes: true, allowedFilesOnly: true }));
} finally { rmSync(directory, { recursive: true, force: true }); }
