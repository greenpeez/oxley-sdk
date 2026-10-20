import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";

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
    import { createOxleyClient, parseDeployment, minimumAmountOut, decodeOxleyRevert, deploymentGeneration } from '@oxley/sdk';
    import { curveAbi, breadthBidHookAbi, gen2CurveAbi } from '@oxley/sdk/abis';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, isCurrentData } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, buildAuctionClaim, buildAuctionRefund } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, quoteAuctionFloor, auctionDurationBlocks, gen2CreatorAccountAbi } from '@oxley/sdk/launch';
    import creatorAbi from '@oxley/sdk/abis/creator-account.json' with { type: 'json' };
    import factoryAbi from '@oxley/sdk/abis/creator-account-factory.json' with { type: 'json' };
    import controllerAbi from '@oxley/sdk/abis/auction-controller.json' with { type: 'json' };
    import bidRouterAbi from '@oxley/sdk/abis/auction-bid-router.json' with { type: 'json' };
    import adapterAbi from '@oxley/sdk/abis/auction-adapter.json' with { type: 'json' };
    import ccaAbi from '@oxley/sdk/abis/cca-auction.json' with { type: 'json' };
    import deployment from '@oxley/sdk/deployments/elysium-testnet.json' with { type: 'json' };
    import gen2Deployment from '@oxley/sdk/deployments/elysium-testnet-gen2.json' with { type: 'json' };
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
  `);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "consumer.ts"), `
    import { createOxleyClient, type QuoteRequest, type Swap } from '@oxley/sdk';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, type IndexedData, type IndexedTrade } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, type AuctionBidInput } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, sampleSecondsPerBlock, type AuctionLaunchInput } from '@oxley/sdk/launch';
    import { decodeOxleyRevert, type OxleyRevert } from '@oxley/sdk';
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
    export const reason = (error: unknown): OxleyRevert | null => decodeOxleyRevert(error);
    export const data = createOxleyDataClient({ baseUrl: 'https://example.com/api/data/v1', chainId: 99801 });
    export const trades: (id: \`0x\${string}\`) => Promise<IndexedData<IndexedTrade>> =
      dealId => data.trades({ dealId, from: 100, to: 200 });
  `);
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.ts"],
  { cwd: directory, stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(join(directory, "node_modules/@oxley/sdk/package.json")));
  assert.ok(!JSON.stringify(manifest.dependencies).includes("workspace:"));
  console.log(JSON.stringify({ filename: pack.filename, size: pack.size, unpackedSize: pack.unpackedSize,
    files: pack.files.length, integrity: pack.integrity, cleanConsumerImport: true, cleanConsumerTypes: true, allowedFilesOnly: true }));
} finally { rmSync(directory, { recursive: true, force: true }); }
