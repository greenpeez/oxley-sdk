import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyDataClient } from "../src/data.js";
import { createOxleyLaunchClient } from "../src/launch.js";
import { createOxleyMetadataClient, emptyTokenMetadata, publicationTypedData, tokenMetadataMessage } from "../src/metadata.js";

// Read-only: the token details service read as the SDK reads it, and the signing data it would build compared with the chain. Nothing is signed or published: no key exists
// here, and a publication is an authenticated write to the live service.
const deployment = JSON.parse(readFileSync(new URL("../deployments/elysium-testnet.json", import.meta.url), "utf8"));
let nextRequest = 0;
const pacedFetch: typeof fetch = async (input, init) => {
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Date.now() + wait + 550;
  await delay(wait);
  return fetch(input, init);
};
const publicClient = createPublicClient({ transport: http(process.env.OXLEY_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz", { timeout: 30_000, retryCount: 1, fetchFn: pacedFetch }) });
const launches = createOxleyLaunchClient({ publicClient, deployment });
const app = process.env.OXLEY_APP_URL ?? "https://app.oxley.fun";
const data = createOxleyDataClient({ baseUrl: `${app}/api/data/v1`, chainId: deployment.chainId });
const details = createOxleyMetadataClient({ baseUrl: app });
const page = await data.auctions({ model: "cca", limit: 5 });
assert.ok(page.items.length > 0, "the index lists auctions");
const checked = [];
for (const auction of page.items.slice(0, 3)) {
  const identity = { dealId: auction.dealId as Hex, coin: auction.coin as Address, creator: auction.creator as Address };
  // From chain: the creator account, its controller and its handover epoch.
  const chain = await launches.getLaunch({ creatorAccount: auction.creator as Address });
  assert.equal(chain.dealId.toLowerCase(), auction.dealId.toLowerCase()); assert.equal(chain.launch?.coin.toLowerCase(), auction.coin.toLowerCase());
  // From the service: the same signing authority.
  const scope = await details.readPublisher(identity);
  assert.deepEqual([scope.kind, scope.controller, scope.epoch], ["account", chain.accountController!.toLowerCase(), chain.handoverCount]);
  const saved = await details.readTokenMetadata([identity.dealId]);
  const resolved = await details.resolveToken(identity.dealId);
  assert.deepEqual([resolved.coin, resolved.creator], [identity.coin, identity.creator]);
  // The request the SDK would sign for an empty-details save: its typed data is the account's domain, its signer the chain's controller, its time the service's.
  const prepared = await details.prepareMetadataPublication({ ...identity, metadata: emptyTokenMetadata(), epoch: chain.handoverCount, controller: chain.accountController! });
  assert.equal(prepared.message, tokenMetadataMessage(prepared.intent)); assert.equal(prepared.signer, chain.accountController!.toLowerCase());
  assert.deepEqual(prepared.signing.method === "eth_signTypedData_v4" ? prepared.signing.typedData : null,
    publicationTypedData({ creatorAccount: identity.creator, purpose: "metadata", message: prepared.message, epoch: chain.handoverCount, issuedAt: prepared.issuedAt }));
  assert.ok(Math.abs(prepared.issuedAt - Date.now() / 1000) < 120, "the service's clock is the wall clock");
  checked.push({ dealId: identity.dealId, creatorAccount: identity.creator, epoch: chain.handoverCount, kind: scope.kind, controllerMatchesChain: true, savedRevision: saved[0]?.revision ?? 0, image: resolved.cid, generation: resolved.nativeGeneration });
}
console.log(JSON.stringify({ version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, chainId: deployment.chainId, readOnly: true, app, tokensChecked: checked.length,
  publisherMatchesChain: true, publicationTypedDataMatches: true, checked }, (_, v) => typeof v === "bigint" ? v.toString() : v));
