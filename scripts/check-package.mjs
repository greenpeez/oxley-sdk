import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { MANIFESTS } from "./deployment-manifests.mjs";

// Exercise the actual archive from an unrelated project, not a workspace symlink.
const root = process.cwd();
const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" });
const [pack] = JSON.parse(output);
assert.ok(pack.files.some(file => file.path === "dist/index.js"));
assert.ok(pack.files.some(file => file.path === "dist/index.d.ts"));
assert.ok(pack.files.some(file => file.path === "dist/data.d.ts"));
assert.ok(pack.files.some(file => file.path === "docs/data-api.md"));
assert.ok(pack.files.some(file => file.path === "dist/auctions.d.ts"));
assert.ok(pack.files.some(file => file.path === "docs/auctions.md"));
assert.ok(pack.files.some(file => file.path === "dist/launch.d.ts"));
assert.ok(pack.files.some(file => file.path === "docs/launch.md"));
assert.ok(pack.files.some(file => file.path === "deployments/elysium-testnet-gen2.json"));
assert.ok(pack.files.some(file => file.path === "docs/gen2-artifacts.json"));
for (const path of ["deployments/elysium-testnet-gen3.json", "deployments/elysium-testnet-gen8.json", "docs/markets.md", "docs/integrator-fees.md",
  "docs/live-artifacts.json", "abis/ElysiumCurveGen8.json", "abis/ElysiumReserveCurveGen3.json", "abis/OxleyTermsRegistry.json", "examples/integrator-fee.ts"]) {
  assert.ok(pack.files.some(file => file.path === path), path);
}
// Optional manifests (Gen9, whose live manifest is not bundled) ship exactly when they exist; an absent one is reported, never invented.
// A required manifest (Gen10 among them) must be in the package.
const optional = MANIFESTS.filter(entry => !entry.required).map(entry => ({ ...entry, present: existsSync(join(root, entry.file)) }));
for (const entry of optional) {
  assert.equal(pack.files.some(file => file.path === entry.file), entry.present, `${entry.file} is packed exactly when it exists`);
  if (!entry.present) console.log(`${entry.file} is absent: ${entry.generation} is not bundled`);
}
for (const entry of MANIFESTS.filter(item => item.required)) assert.ok(pack.files.some(file => file.path === entry.file), `${entry.file} is packed`);
const gen9Present = optional.some(entry => entry.generation === "gen9" && entry.present);
const generations = MANIFESTS.filter(entry => entry.required || existsSync(join(root, entry.file))).map(entry => entry.generation ?? "flat-fee");
for (const file of pack.files) {
  assert.ok(/^(dist\/|abis\/|docs\/|deployments\/|examples\/|README\.md$|LICENSE$|package\.json$)/.test(file.path), file.path);
  assert.ok(!/(\.env|node_modules|test\/|fixtures|\.log$|private.key)/i.test(file.path), file.path);
}
const directory = mkdtempSync(join(tmpdir(), "oxley-sdk-consumer-"));
try {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(root, pack.filename)],
    { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "consumer.mjs"), `
    import assert from 'node:assert/strict';
    import { encodeErrorResult } from 'viem';
    import { createOxleyClient, parseDeployment, minimumAmountOut, decodeOxleyRevert, deploymentGeneration, createOxleyMarkets, testnetDeployments,
      buildSwapWithFee, integratorFeeAmount, MAX_INTEGRATOR_FEE_BPS, buildAcceptTerms, openingSurchargeWadAt, termsRegistryAbi,
      gen9TestnetDeployment, gen10TestnetDeployment, isGen8Family, GEN9_MAX_FLOOR_PRICE_WAD, GEN8_FAMILY, gen8MinimumNetRaise, gen8MinimumGrossRaise,
      launchMinimumRaiseAbi } from '@oxley/sdk';
    import { curveAbi, breadthBidHookAbi, gen2CurveAbi, launchFloorCapAbi } from '@oxley/sdk/abis';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, isCurrentData } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, buildAuctionClaim, buildAuctionRefund, buildDynamicBid, GEN8_BID_RULES, gen8BidHookAbi } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, quoteAuctionFloor, auctionDurationBlocks, gen2CreatorAccountAbi, floorReachesMinimumRaise, minimumRaiseFloor,
      validateLaunchFloor } from '@oxley/sdk/launch';
    import creatorAbi from '@oxley/sdk/abis/creator-account.json' with { type: 'json' };
    import factoryAbi from '@oxley/sdk/abis/creator-account-factory.json' with { type: 'json' };
    import controllerAbi from '@oxley/sdk/abis/auction-controller.json' with { type: 'json' };
    import bidRouterAbi from '@oxley/sdk/abis/auction-bid-router.json' with { type: 'json' };
    import adapterAbi from '@oxley/sdk/abis/auction-adapter.json' with { type: 'json' };
    import ccaAbi from '@oxley/sdk/abis/cca-auction.json' with { type: 'json' };
    import deployment from '@oxley/sdk/deployments/elysium-testnet.json' with { type: 'json' };
    import gen2Deployment from '@oxley/sdk/deployments/elysium-testnet-gen2.json' with { type: 'json' };
    import gen3Deployment from '@oxley/sdk/deployments/elysium-testnet-gen3.json' with { type: 'json' };
    import gen8Deployment from '@oxley/sdk/deployments/elysium-testnet-gen8.json' with { type: 'json' };
    ${gen9Present ? "import gen9Deployment from '@oxley/sdk/deployments/elysium-testnet-gen9.json' with { type: 'json' };" : ""}
    import gen10Deployment from '@oxley/sdk/deployments/elysium-testnet-gen10.json' with { type: 'json' };
    import gen3Curve from '@oxley/sdk/abis/gen3/curve.json' with { type: 'json' };
    import termsAbi from '@oxley/sdk/abis/terms-registry.json' with { type: 'json' };
    import gen8Curve from '@oxley/sdk/abis/gen8/curve.json' with { type: 'json' };
    import gen8Router from '@oxley/sdk/abis/gen8/bid-router.json' with { type: 'json' };
    import gen8Hook from '@oxley/sdk/abis/gen8/bid-hook.json' with { type: 'json' };
    import gen2Controller from '@oxley/sdk/abis/gen2/auction-controller.json' with { type: 'json' };
    import gen2Account from '@oxley/sdk/abis/gen2/creator-account.json' with { type: 'json' };
    import gen2Factory from '@oxley/sdk/abis/gen2/creator-account-factory.json' with { type: 'json' };
    import gen2Router from '@oxley/sdk/abis/gen2/bid-router.json' with { type: 'json' };
    import gen2Hook from '@oxley/sdk/abis/gen2/bid-hook.json' with { type: 'json' };
    import gen2Adapter from '@oxley/sdk/abis/gen2/adapter.json' with { type: 'json' };
    import gen2Curve from '@oxley/sdk/abis/gen2/curve.json' with { type: 'json' };
    import abi from '@oxley/sdk/abis/curve.json' with { type: 'json' };
    assert.equal(parseDeployment(deployment).chainId, 99801);
    assert.equal(minimumAmountOut(1000000n, 50), 995000n);
    assert.ok(curveAbi.length && abi.length && createOxleyClient && buildZeroExBasic);
    assert.ok(createOxleyDataClient({ baseUrl: 'https://example.com/api/data/v1', chainId: 99801 }).candles);
    assert.equal(typeof createOxleyDataClient({ baseUrl: 'https://example.com/api/data/v1', chainId: 99801 }).tokens, 'function');
    assert.equal(isCurrentData({ checkedAt: 0, freshness: 'fresh' }), false);
    assert.ok(createOxleyAuctionClient && buildAuctionClaim && buildAuctionRefund);
    assert.ok(controllerAbi.length && bidRouterAbi.length && adapterAbi.length && ccaAbi.length);
    assert.ok(creatorAbi.length && factoryAbi.length && createOxleyLaunchClient);
    assert.ok(quoteAuctionFloor(10000000000000000000n).floorPriceQ96 > 0n);
    assert.equal(deploymentGeneration(parseDeployment(gen2Deployment)), 'gen2');
    assert.equal(gen2Deployment.status, 'planned-fork-addresses');
    assert.equal(auctionDurationBlocks({ hours: 1, secondsPerBlock: 0.1363 }), 26412);
    assert.equal(decodeOxleyRevert('0x50fef614')?.name, 'ExactDurationRequired');
    assert.ok(breadthBidHookAbi.length && gen2CurveAbi.length && gen2CreatorAccountAbi.length);
    assert.ok([gen2Controller, gen2Account, gen2Factory, gen2Router, gen2Hook, gen2Adapter, gen2Curve].every(abi => abi.length));
    assert.deepEqual(testnetDeployments.map(d => deploymentGeneration(parseDeployment(d))), ${JSON.stringify(generations)});
    assert.equal(gen9TestnetDeployment === undefined, ${!gen9Present});
    ${gen9Present ? "assert.equal(deploymentGeneration(parseDeployment(gen9Deployment)), 'gen9');" : ""}
    assert.ok(isGen8Family('gen8') && isGen8Family('gen9') && isGen8Family('gen10') && !isGen8Family('gen3') && GEN9_MAX_FLOOR_PRICE_WAD === 10n ** 21n);
    assert.equal(deploymentGeneration(parseDeployment(gen10Deployment)), 'gen10'); assert.deepEqual(gen10TestnetDeployment, gen10Deployment);
    assert.equal(parseDeployment(gen10Deployment).releaseId, 'elysium-auctions-gen10-1fa4ef2a98fd14ed');
    assert.equal(parseDeployment(gen10Deployment).termsRegistry.address, '0x94c8c7203e2a01e37f104fa6cbe00382642c084d');
    assert.deepEqual([GEN8_FAMILY.gen8.minimumNetRaise, GEN8_FAMILY.gen9.minimumNetRaise, gen8MinimumNetRaise('gen10')], [50000000000n, 50000000000n, 30000000000n]);
    assert.deepEqual([gen8MinimumGrossRaise('gen9'), gen8MinimumGrossRaise('gen10')], [50505050505n, 30303030303n]);
    assert.equal(minimumRaiseFloor('gen10'), 101010101030162826490n); assert.ok(minimumRaiseFloor('gen9') > minimumRaiseFloor('gen10'));
    assert.ok(floorReachesMinimumRaise('gen10', 110000000000000000000n) && !floorReachesMinimumRaise('gen9', 110000000000000000000n));
    assert.doesNotThrow(() => validateLaunchFloor('gen10', 110000000000000000000n)); assert.throws(() => validateLaunchFloor('gen9', 110000000000000000000n), /minimum raise/);
    assert.ok(launchMinimumRaiseAbi.length === 2 && quoteAuctionFloor(110000000000000000000n).floorPriceQ96 > 0n);
    assert.equal(decodeOxleyRevert(encodeErrorResult({ abi: launchFloorCapAbi, errorName: 'FloorPriceAboveMaximum', args: [10n ** 21n + 1n, 10n ** 21n] }))?.name, 'FloorPriceAboveMaximum');
    assert.equal(parseDeployment(gen3Deployment).termsRegistry.address, parseDeployment(testnetDeployments[1]).termsRegistry.address);
    assert.equal(parseDeployment(gen8Deployment).releaseId, 'elysium-auctions-gen8-969bd0e317da4145');
    assert.ok(createOxleyMarkets && buildSwapWithFee && buildAcceptTerms && buildDynamicBid && termsRegistryAbi.length && gen8BidHookAbi.length);
    assert.equal(integratorFeeAmount(10000000n, 50), 50000n); assert.equal(MAX_INTEGRATOR_FEE_BPS, 100);
    assert.equal(openingSurchargeWadAt(45), 8437500000000000n); assert.equal(GEN8_BID_RULES.minBid, '20000000');
    assert.ok([gen3Curve, termsAbi, gen8Curve, gen8Router, gen8Hook].every(abi => abi.length));
  `);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "consumer.ts"), `
    import { createOxleyClient, createOxleyMarkets, type QuoteRequest, type Swap, type SwapWithFee, type TermsStatus } from '@oxley/sdk';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, type IndexedData, type IndexedTrade, type TokenInfo } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, type AuctionBidInput, type DynamicBidLimits } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, sampleSecondsPerBlock, type AuctionLaunchInput } from '@oxley/sdk/launch';
    import { decodeOxleyRevert, isGen8Family, type DeploymentGeneration, type Gen8FamilyId, type OxleyRevert } from '@oxley/sdk';
    import { createPublicClient, http } from 'viem';
    export const client = (deployment: unknown) => createOxleyClient({ deployment,
      publicClient: createPublicClient({ transport: http('http://localhost:8545') }) });
    export const encode = (swap: Swap) => buildZeroExBasic(swap);
    export type Input = QuoteRequest;
    export const auctions = (deployment: unknown) => createOxleyAuctionClient({ deployment,
      publicClient: createPublicClient({ transport: http('http://localhost:8545') }) });
    export type AuctionInput = AuctionBidInput;
    export const launch = (deployment: unknown, input: AuctionLaunchInput) => createOxleyLaunchClient({ deployment,
      publicClient: createPublicClient({ transport: http('http://localhost:8545') }) }).prepareLaunch(input);
    export const gen2Bid = (deployment: unknown, dealId: \`0x\${string}\`, owner: \`0x\${string}\`) => createOxleyAuctionClient({ deployment,
      publicClient: createPublicClient({ transport: http('http://localhost:8545') }) }).getBidAllowance({ dealId, owner });
    export const rate = () => sampleSecondsPerBlock(createPublicClient({ transport: http('http://localhost:8545') }));
    export const reason = (error: unknown): OxleyRevert | null => decodeOxleyRevert(error, { generation: 'gen10' });
    export const family = (generation: DeploymentGeneration): generation is Gen8FamilyId => isGen8Family(generation);
    export const markets = createOxleyMarkets({ publicClient: createPublicClient({ transport: http('http://localhost:8545') }) });
    export const withFee = (request: Parameters<typeof markets.prepareSwapWithFee>[0]): Promise<SwapWithFee> => markets.prepareSwapWithFee(request);
    export const terms = (marketId: \`0x\${string}\`, account: \`0x\${string}\`): Promise<TermsStatus> => markets.getTermsStatus({ marketId, account });
    export const limits = (deployment: unknown, dealId: \`0x\${string}\`, owner: \`0x\${string}\`): Promise<DynamicBidLimits> => createOxleyAuctionClient({ deployment,
      publicClient: createPublicClient({ transport: http('http://localhost:8545') }) }).getDynamicBidLimits({ dealId, owner });
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
