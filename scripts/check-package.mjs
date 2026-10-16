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
    import { createOxleyClient, parseDeployment, minimumAmountOut } from '@oxley/sdk';
    import { curveAbi } from '@oxley/sdk/abis';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, isCurrentData } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, buildAuctionClaim, buildAuctionRefund } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, quoteAuctionFloor } from '@oxley/sdk/launch';
    import creatorAbi from '@oxley/sdk/abis/creator-account.json' with { type: 'json' };
    import factoryAbi from '@oxley/sdk/abis/creator-account-factory.json' with { type: 'json' };
    import controllerAbi from '@oxley/sdk/abis/auction-controller.json' with { type: 'json' };
    import bidRouterAbi from '@oxley/sdk/abis/auction-bid-router.json' with { type: 'json' };
    import adapterAbi from '@oxley/sdk/abis/auction-adapter.json' with { type: 'json' };
    import ccaAbi from '@oxley/sdk/abis/cca-auction.json' with { type: 'json' };
    import deployment from '@oxley/sdk/deployments/elysium-testnet.json' with { type: 'json' };
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
  `);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, stdio: "pipe" });
  writeFileSync(join(directory, "consumer.ts"), `
    import { createOxleyClient, type QuoteRequest, type Swap } from '@oxley/sdk';
    import { buildZeroExBasic } from '@oxley/sdk/0x';
    import { createOxleyDataClient, type IndexedData, type IndexedTrade } from '@oxley/sdk/data';
    import { createOxleyAuctionClient, type AuctionBidInput } from '@oxley/sdk/auctions';
    import { createOxleyLaunchClient, type AuctionLaunchInput } from '@oxley/sdk/launch';
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
