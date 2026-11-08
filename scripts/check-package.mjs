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
for (const path of ["dist/index.js", "dist/index.d.ts", "dist/data.d.ts", "dist/auctions.d.ts", "dist/launch.d.ts", "dist/abis.d.ts", "dist/zero-ex.d.ts",
  "docs/data-api.md", "docs/auctions.md", "docs/launch.md", "docs/markets.md", "docs/integrator-fees.md", "docs/mainnet.md", "docs/live-artifacts.json",
  MANIFEST.file, "deployments/mainnet.template.json", "abis/curve.json", "abis/bid-router.json", "abis/bid-hook.json", "abis/terms-registry.json",
  "abis/cca-auction.json", "abis/auction-controller.json", "abis/adapter.json", "abis/registry.json", "abis/exposure-helper.json", "abis/creator-account.json",
  "abis/creator-account-factory.json", "abis/bond-escrow.json", "abis/entry-controller.json", "examples/dynamic-bid.ts", "examples/integrator-fee.ts",
  "examples/launch.ts", "examples/launch-floor.ts"]) assert.ok(packed(path), path);
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
      "curveAbi", "launchBondAbi", "launchControllerAbi", "launchEntryAbi", "launchFloorAbi", "launchFloorCapAbi", "launchMinimumRaiseAbi", "openingFeeCurveAbi",
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
      "auctionDurationBlocks", "auctionDurationBounds", "buildAcceptTerms", "buildAuctionLaunch", "buildCreatorAccount", "buildLaunchApprovals", "createOxleyLaunchClient",
      "creatorAccountAbi", "creatorAccountFactoryAbi", "decodeOxleyRevert", "floorReachesMinimumRaise", "launchBondAbi", "launchControllerAbi", "launchDealId", "launchEntryAbi",
      "launchFloorAbi", "launchFloorCapAbi", "launchMinimumRaiseAbi", "minimumRaiseFloor", "newDraftSalt", "quoteAuctionFloor", "sampleSecondsPerBlock", "validateAuctionLaunch",
      "validateLaunchFloor"])});
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
    assert.ok([curveAbi, bidRouterAbi, bidHookAbi, termsAbi, ccaAbi, controllerAbi, adapterAbi, registryAbi, exposureAbi, creatorAccountAbi, factoryAbi, bondEscrowAbi, entryAbi].every(abi => abi.length));
    assert.ok(abis.curveAbi.length && abis.bidHookAbi.length && abis.termsRegistryAbi.length && abis.creatorAccountAbi.length && abis.launchControllerAbi.length);
    assert.ok(factoryAbi.some(entry => entry.name === 'createAccountForDraft') && creatorAccountAbi.some(entry => entry.name === 'launchAuctionWithCommitmentAndExactDuration'));
  `);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "consumer.ts"), `
    import { createOxleyClient, testnetDeployment, type Deployment, type QuoteRequest, type Swap, type SwapWithFee, type TermsStatus } from '@oxley/sdk';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, type IndexedData, type IndexedTrade, type TokenInfo } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, type DynamicBidLimits, type DynamicBidRequest, type PartialFillHints } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, quoteAuctionFloor, validateLaunchFloor, type AuctionLaunchInput, type LaunchStage } from '@oxley/sdk/launch';
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
    export const nextStep = async (deployment: unknown, input: AuctionLaunchInput): Promise<LaunchStage | 'complete'> => (await launches(deployment).prepareLaunch(input)).stage;
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
