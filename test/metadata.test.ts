import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { concat, encodeAbiParameters, hashMessage, hashTypedData, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as metadata from "../src/metadata.js";
import { OXLEY_APP_URL, PUBLICATION_PURPOSE, createOxleyMetadataClient, emptyTokenMetadata, inspectTokenImage, normalizePublicationSignature, parseTokenImageIntent,
  parseTokenMetadataFields, parseTokenMetadataIntent, publicationTypedData, tokenImageMessage, tokenMetadataHash, tokenMetadataMessage, validTokenMetadataRecord, validateTokenImage,
  type TokenMetadataIntent, type TokenImageIntent } from "../src/metadata.js";
import { OxleyError } from "../src/index.js";
import { addr, full } from "./support/chain.js";

const code = (expected: string) => (error: unknown) => error instanceof OxleyError && error.code === expected;
const DEAL = `0x${"1".repeat(64)}` as Hex, COIN = `0x${"2".repeat(40)}` as Address, ACCOUNT = `0x${"3".repeat(40)}` as Address;
const fields = { description: "A token", website: "https://example.test/", x: "https://x.com/example", telegram: "https://t.me/example" };
const intent: TokenMetadataIntent = { chainId: 99801, dealId: DEAL, coin: COIN, creator: ACCOUNT, metadataHash: "4".repeat(64), expectedRevision: 0, origin: "https://app.oxley.fun", issuedAt: 100 };
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

test("details are canonical as the service stores them: trimmed, line-normalized, HTTPS links on the right hosts, nothing else", () => {
  assert.deepEqual(parseTokenMetadataFields({ ...fields, description: " A token\r\n " }), fields);
  assert.deepEqual(parseTokenMetadataFields(emptyTokenMetadata()), emptyTokenMetadata());
  assert.deepEqual(parseTokenMetadataFields({ description: "a\r\nb\rc\td", website: " https://Example.test ", x: "https://www.twitter.com/Name", telegram: "https://t.me/x" }),
    { description: "a\nb\nc\td", website: "https://example.test/", x: "https://www.twitter.com/Name", telegram: "https://t.me/x" });
  const bad: [string, unknown][] = [["INVALID_METADATA", { ...fields, floorPriceWad: "1" }], ["INVALID_METADATA", { description: "x" }], ["INVALID_METADATA", null], ["INVALID_METADATA", []],
    ["INVALID_DESCRIPTION", { ...fields, description: "x".repeat(2001) }], ["INVALID_DESCRIPTION", { ...fields, description: "hidden\0control" }], ["INVALID_DESCRIPTION", { ...fields, description: 5 }],
    ["INVALID_LINK", { ...fields, website: "javascript:alert(1)" }], ["INVALID_LINK", { ...fields, website: "http://example.test" }], ["INVALID_LINK", { ...fields, website: "https://user:password@example.test" }],
    ["INVALID_LINK", { ...fields, website: "https://exa\nmple.test" }], ["INVALID_LINK", { ...fields, website: "https://exa mple.test" }], ["INVALID_LINK", { ...fields, website: "https://example.test/" + "x".repeat(512) }],
    ["INVALID_LINK", { ...fields, x: "https://x.com.evil.test/name" }], ["INVALID_LINK", { ...fields, telegram: "https://other.test/name" }], ["INVALID_LINK", { ...fields, x: 5 }]];
  for (const [expected, value] of bad) assert.throws(() => parseTokenMetadataFields(value), code(expected), JSON.stringify(value));
  // The description limit counts characters as the server does (UTF-16 units), 2,000 passing and 2,001 not.
  assert.doesNotThrow(() => parseTokenMetadataFields({ ...fields, description: "x".repeat(2000) }));
});
test("the hash commits to the canonical details, whatever the key order, and the message names every term of the consent", () => {
  const canonical = JSON.stringify({ description: "A token", website: "https://example.test/", x: "https://x.com/example", telegram: "https://t.me/example" });
  assert.equal(tokenMetadataHash(fields), sha(canonical));
  assert.equal(tokenMetadataHash({ telegram: fields.telegram, x: fields.x, website: fields.website, description: fields.description }), sha(canonical));
  assert.notEqual(tokenMetadataHash(fields), tokenMetadataHash({ ...fields, description: "Changed" }));
  assert.equal(tokenMetadataHash(emptyTokenMetadata()), sha('{"description":"","website":"","x":"","telegram":""}'));
  assert.equal(tokenMetadataMessage(intent), ["Update token description and links on oxley", "Website: https://app.oxley.fun", "Chain: 99801", `Deal: ${DEAL}`, `Coin: ${COIN}`, `Creator account: ${ACCOUNT}`,
    `Metadata SHA-256: ${"4".repeat(64)}`, "Expected revision: 0", "Issued at: 100", "I authorize public publication of these token details.",
    "This signature authorizes no payment, token approval, or change to onchain identity or auction terms."].join("\n"));
  const message = tokenMetadataMessage(intent);
  for (const patch of [{ dealId: `0x${"a".repeat(64)}` }, { coin: `0x${"b".repeat(40)}` }, { creator: `0x${"c".repeat(40)}` }, { metadataHash: "d".repeat(64) }, { expectedRevision: 1 },
    { origin: "https://other.test" }, { issuedAt: 101 }]) assert.notEqual(tokenMetadataMessage({ ...intent, ...patch }), message);
  for (const patch of [{ chainId: 1 }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { coin: `0x${"0".repeat(40)}` },
    { dealId: `0x${"A".repeat(64)}` }, { owner: "unexpected" }, { metadataHash: "4".repeat(63) }]) {
    assert.throws(() => parseTokenMetadataIntent({ ...intent, ...patch }), code("INVALID_INTENT"), JSON.stringify(patch));
  }
  for (const origin of ["https://app.oxley.fun/path", "http://app.oxley.fun", "https://user@app.oxley.fun", "app.oxley.fun", "https://" + "a".repeat(200)]) {
    assert.throws(() => parseTokenMetadataIntent({ ...intent, origin }), code("INVALID_ORIGIN"), origin);
  }
  const record = { chainId: 99801, dealId: DEAL, coin: COIN, creator: ACCOUNT, revision: 1, updatedAt: 100, metadata: { ...fields, description: "<script>text only</script>" } };
  assert.equal(validTokenMetadataRecord(record), true);
  for (const bad of [{ ...record, creator: "0xwrong" }, { ...record, revision: 0 }, { ...record, metadata: { ...record.metadata, name: "Renamed" } }, { ...record, metadata: { ...fields, website: "http://x.test" } }]) {
    assert.equal(validTokenMetadataRecord(bad), false);
  }
});
test("the creator account's publication signature is the typed data its isValidPublicationSignature verifies: EIP-712 OxleyCreatorPublication v8, bound to the account, chain, purpose, content, epoch and deadline", () => {
  assert.equal(PUBLICATION_PURPOSE.metadata, keccak256(stringToHex("OXLEY_TOKEN_METADATA_GEN8")));
  assert.equal(PUBLICATION_PURPOSE.image, keccak256(stringToHex("OXLEY_TOKEN_IMAGE_GEN8")));
  const message = tokenMetadataMessage(intent), typed = publicationTypedData({ creatorAccount: ACCOUNT, purpose: "metadata", message, epoch: 3n, issuedAt: 1_800_000_000 });
  assert.deepEqual(typed.domain, { name: "OxleyCreatorPublication", version: "8", chainId: 99801n, verifyingContract: ACCOUNT });
  assert.deepEqual(typed.message, { purpose: PUBLICATION_PURPOSE.metadata, payloadHash: hashMessage(message), epoch: 3n, deadline: 1_800_000_600n });
  // The digest from first principles, as OpenZeppelin's EIP712 and the account's PUBLICATION_TYPEHASH compute it.
  const typeHash = keccak256(stringToHex("Publication(bytes32 purpose,bytes32 payloadHash,uint256 epoch,uint64 deadline)"));
  const struct = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }],
    [typeHash, PUBLICATION_PURPOSE.metadata, hashMessage(message), 3n, 1_800_000_600n]));
  const domainType = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const domain = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [domainType, keccak256(stringToHex("OxleyCreatorPublication")), keccak256(stringToHex("8")), 99801n, ACCOUNT]));
  assert.equal(hashTypedData(typed), keccak256(concat(["0x1901", domain, struct])));
  // The account's compiled ABI has the function and the constants this reads.
  const compiled = full("creator-account") as readonly { type: string; name?: string }[];
  assert.ok(compiled.some(entry => entry.type === "function" && entry.name === "isValidPublicationSignature"));
  const base = { creatorAccount: ACCOUNT, purpose: "metadata" as const, message, epoch: 3n, issuedAt: 1_800_000_000 }, digest = hashTypedData(typed);
  for (const patch of [{ creatorAccount: addr(9) }, { chainId: 998 }, { purpose: "image" as const }, { epoch: 4n }, { issuedAt: 1_800_000_001 }, { message: `${message}!` }]) {
    assert.notEqual(hashTypedData(publicationTypedData({ ...base, ...patch })), digest, JSON.stringify(patch, (_, v) => typeof v === "bigint" ? v.toString() : v));
  }
  for (const patch of [{ epoch: -1n }, { epoch: 1n << 256n }, { creatorAccount: "0xABC" as Address }, { issuedAt: -1 }, { issuedAt: 2 ** 64 }]) assert.throws(() => publicationTypedData({ ...base, ...patch }));
  assert.throws(() => publicationTypedData({ ...base, epoch: 1 as never }), code("INVALID_EPOCH"));
});
test("signatures are 65 bytes with v 27 or 28 (0 and 1 are converted as the server does); smart-account signatures are refused with the server's code", () => {
  const body = "ab".repeat(64);
  assert.equal(normalizePublicationSignature(`0x${body}1b`), `0x${body}1b`); assert.equal(normalizePublicationSignature(`0x${body}1C`), `0x${body}1c`);
  assert.equal(normalizePublicationSignature(`0x${body}00`), `0x${body}1b`); assert.equal(normalizePublicationSignature(`0x${body}01`), `0x${body}1c`);
  for (const bad of ["nothex", "0x", 5, undefined, `0x${body}02`, `0x${body}ff`]) assert.throws(() => normalizePublicationSignature(bad), code("SIGNATURE_INVALID"), String(bad));
  for (const long of [`0x${body}${"cd".repeat(10)}1b`, `0x${"ab".repeat(32)}`]) assert.throws(() => normalizePublicationSignature(long), code("SIGNATURE_UNSUPPORTED"));
});

// Minimal headers of each format: enough for the checks the service makes before it decodes.
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => [...s].map(c => c.charCodeAt(0));
const chunk = (type: string, body: number[]) => [...u32(body.length), ...text(type), ...body, 0, 0, 0, 0];
const png = (w: number, h: number, animated = false) => Uint8Array.from([0x89, ...text("PNG"), 13, 10, 26, 10, ...chunk("IHDR", [...u32(w), ...u32(h), 8, 2, 0, 0, 0]), ...animated ? chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]) : [], ...chunk("IDAT", [])]);
const jpeg = (w: number, h: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const riff = (kind: string, body: number[]) => Uint8Array.from([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(kind), body.length & 255, 0, 0, 0, ...body, ...new Array(Math.max(0, 14 - body.length)).fill(0)]);
const webpLossless = (w: number, h: number) => { const bits = (w - 1) | ((h - 1) << 14); return riff("VP8L", [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]); };
const webpLossy = (w: number, h: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8]);
const webpExtended = (w: number, h: number, flags = 0) => riff("VP8X", [flags, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]);
test("an image is checked as the upload route checks it: PNG, JPEG or WebP, 900 KB, one frame, 16 million pixels, hashed over the uploaded bytes", () => {
  const sizes: [string, Uint8Array, string, number, number][] = [["png", png(512, 256), "image/png", 512, 256], ["jpeg", jpeg(640, 480), "image/jpeg", 640, 480],
    ["lossless webp", webpLossless(300, 200), "image/webp", 300, 200], ["lossy webp", webpLossy(321, 123), "image/webp", 321, 123], ["extended webp", webpExtended(1000, 2000), "image/webp", 1000, 2000]];
  for (const [label, bytes, mime, width, height] of sizes) {
    const checked = validateTokenImage(bytes);
    assert.deepEqual([checked.mime, checked.width, checked.height, checked.animated, checked.imageHash], [mime, width, height, false, sha(bytes)], label);
  }
  const bad: [string, Uint8Array][] = [["INVALID_IMAGE", new Uint8Array()], ["INVALID_IMAGE", Uint8Array.from(text("GIF89a......"))], ["INVALID_IMAGE", png(0, 5)], ["INVALID_IMAGE", Uint8Array.from([0x89, ...text("PNG")])],
    ["INVALID_IMAGE", "not bytes" as never], ["IMAGE_ANIMATED", png(10, 10, true)], ["IMAGE_ANIMATED", webpExtended(10, 10, 0x02)], ["IMAGE_TOO_LARGE", png(4001, 4000)],
    ["IMAGE_TOO_LARGE", new Uint8Array(900_001).fill(1)], ["IMAGE_TOO_LARGE", webpExtended(5000, 3201)]];
  for (const [expected, bytes] of bad) assert.throws(() => validateTokenImage(bytes), code(expected), expected);
  assert.doesNotThrow(() => validateTokenImage(png(4000, 4000))); assert.doesNotThrow(() => validateTokenImage(Uint8Array.from([...png(1, 1), ...new Uint8Array(899_900)])));
  assert.equal(inspectTokenImage(Uint8Array.from(text("RIFFxxxxWEBPVP9 ........................"))), null);
  const imageIntent: TokenImageIntent = { chainId: 99801, dealId: DEAL, coin: COIN, creator: ACCOUNT, imageHash: sha("x"), origin: "https://app.oxley.fun", issuedAt: 100 };
  assert.equal(tokenImageMessage(imageIntent), ["Publish token image on oxley", "Website: https://app.oxley.fun", "Chain: 99801", `Deal: ${DEAL}`, `Coin: ${COIN}`, `Creator: ${ACCOUNT}`,
    `Image SHA-256: ${sha("x")}`, "Issued at: 100", "I authorize permanent public publication of this image and its write-once token association.",
    "I own or have permission to use this image. This signature authorizes no payment or token approval."].join("\n"));
  assert.doesNotThrow(() => parseTokenImageIntent({ ...imageIntent, origin: "http://localhost:3000" }));
  for (const patch of [{ imageHash: "zz" }, { chainId: 1 }, { issuedAt: 1.5 }, { extra: 1 }]) assert.throws(() => parseTokenImageIntent({ ...imageIntent, ...patch }), code("INVALID_INTENT"));
  assert.throws(() => parseTokenImageIntent({ ...imageIntent, origin: "ftp://x.test" }), code("INVALID_ORIGIN"));
});

// A stand-in for the service: it answers the routes the client calls and records every request.
const SERVER_DATE = "Sun, 08 Nov 2026 18:02:09 GMT", SERVER_TIME = Math.floor(Date.parse(SERVER_DATE) / 1000);
interface Call { url: URL; method: string; headers: Record<string, string>; body: unknown }
function service(options: { revision?: number; kind?: "account" | "eoa"; epoch?: string; controller?: string; post?: (call: Call, attempt: number) => Response | undefined; fixedItem?: boolean } = {}) {
  const calls: Call[] = [];
  const respond = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { date: SERVER_DATE, "content-type": "application/json", ...extra } });
  let posts = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url, method: init?.method ?? "GET", headers, body: init?.body };
    calls.push(call);
    if (call.method === "POST") {
      const attempt = ++posts, forced = options.post?.(call, attempt);
      if (forced) return forced;
      if (url.pathname.endsWith("token-images")) return respond({ cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" });
      const body = JSON.parse(String(init!.body)) as { intent: TokenMetadataIntent; metadata: typeof fields };
      return respond({ item: { chainId: 99801, dealId: body.intent.dealId, coin: body.intent.coin, creator: body.intent.creator, revision: body.intent.expectedRevision + 1, updatedAt: SERVER_TIME, metadata: body.metadata } });
    }
    if (url.pathname.endsWith("token-metadata")) {
      const ids = url.searchParams.get("ids")!.split(",");
      return respond({ items: !options.revision ? [] : ids.map(dealId => ({ chainId: 99801, dealId, coin: COIN, creator: ACCOUNT, revision: options.revision, updatedAt: 5, metadata: fields })) });
    }
    if (url.searchParams.has("publisher")) {
      return respond({ publisher: { dealId: DEAL, coin: COIN, creator: ACCOUNT, controller: options.controller ?? ACCOUNT, ...options.kind === "eoa" ? { publicationKind: "eoa" }
        : { publication: { generation: "gen10", chainId: 99801, account: ACCOUNT, epoch: options.epoch ?? "2", blockHash: `0x${"5".repeat(64)}` } } } });
    }
    if (url.searchParams.has("publication")) return respond({ items: [{ dealId: DEAL, coin: COIN, creator: ACCOUNT, cid: null, nativeGeneration: "gen10" }] });
    return respond({ available: true });
  };
  return { fetch, calls, posts: () => calls.filter(call => call.method === "POST") };
}
const client = (svc: ReturnType<typeof service>, extra: Partial<Parameters<typeof createOxleyMetadataClient>[0]> = {}) =>
  createOxleyMetadataClient({ fetch: svc.fetch, elapsed: () => 0, sleep: async () => undefined, ...extra });

test("details are published for the creator account's controller: the SDK builds the intent from the service's clock and revision, the controller signs typed data, the signed payload is sent with the origin", async () => {
  const controller = privateKeyToAccount(generatePrivateKey()), svc = service({ revision: 2, controller: controller.address }), meta = client(svc);
  const prepared = await meta.prepareMetadataPublication({ dealId: DEAL.toUpperCase().replace("0X", "0x"), coin: COIN, creator: ACCOUNT, metadata: { ...fields, description: " A token \r\n" } });
  // The intent: the service's clock (its Date header), the saved revision, the application's origin, the hash of the canonical details.
  assert.deepEqual(prepared.intent, { chainId: 99801, dealId: DEAL, coin: COIN, creator: ACCOUNT, metadataHash: sha(JSON.stringify(fields)), expectedRevision: 2, origin: OXLEY_APP_URL, issuedAt: SERVER_TIME });
  assert.equal(prepared.message, tokenMetadataMessage(prepared.intent)); assert.deepEqual(prepared.metadata, fields);
  assert.deepEqual([prepared.purpose, prepared.signer, prepared.epoch, prepared.expiresAt, prepared.origin], ["metadata", controller.address.toLowerCase(), 2n, SERVER_TIME + 590, OXLEY_APP_URL]);
  assert.equal(prepared.signing.method, "eth_signTypedData_v4");
  if (prepared.signing.method !== "eth_signTypedData_v4") throw new Error("typed data expected");
  assert.deepEqual(prepared.signing.typedData, publicationTypedData({ creatorAccount: ACCOUNT, purpose: "metadata", message: prepared.message, epoch: 2n, issuedAt: SERVER_TIME }));
  assert.ok(Object.isFrozen(prepared));
  assert.deepEqual(svc.calls.map(call => call.url.pathname + (call.url.searchParams.has("publisher") ? "?publisher" : "")), ["/api/elysium/token-metadata", "/api/elysium/token-images?publisher"]);
  // The wallet signs; the SDK checks who signed before anything is sent, and sends the intent, the details and the signature.
  const signature = await controller.signTypedData(prepared.signing.typedData);
  const item = await meta.submitMetadataPublication(prepared, signature);
  assert.deepEqual([item.revision, item.metadata, item.dealId], [3, fields, DEAL]);
  const post = svc.posts()[0]!, sent = JSON.parse(String(post.body));
  assert.deepEqual([post.url.pathname, post.method, post.headers.origin, post.headers["content-type"]], ["/api/elysium/token-metadata", "POST", "https://app.oxley.fun", "application/json"]);
  assert.deepEqual(sent, { intent: prepared.intent, metadata: fields, signature });
  assert.ok(String(post.body).length < 16_384);
  // Someone else's signature never leaves the machine; neither does a malformed one or one a smart account made.
  const stranger = privateKeyToAccount(generatePrivateKey()), wrong = await stranger.signTypedData(prepared.signing.typedData);
  await assert.rejects(meta.submitMetadataPublication(prepared, wrong), code("SIGNER_MISMATCH"));
  await assert.rejects(meta.submitMetadataPublication(prepared, "0x1234"), code("SIGNATURE_UNSUPPORTED"));
  await assert.rejects(meta.submitMetadataPublication(prepared, "nope"), code("SIGNATURE_INVALID"));
  assert.equal(svc.posts().length, 1);
  // With a public client the creator account itself is asked, as the service asks it.
  const reads: unknown[] = [];
  const chain = (accepted: boolean) => ({ readContract: async (request: unknown) => { reads.push(request); return accepted; } }) as never;
  await meta.submitMetadataPublication(prepared, signature, { publicClient: chain(true) });
  assert.deepEqual((reads[0] as { address: string; functionName: string; args: unknown[] }).functionName, "isValidPublicationSignature");
  assert.deepEqual((reads[0] as { args: unknown[] }).args.slice(0, 4), [PUBLICATION_PURPOSE.metadata, hashMessage(prepared.message), 2n, BigInt(SERVER_TIME + 600)]);
  assert.equal((reads[0] as { address: string }).address, ACCOUNT);
  await assert.rejects(meta.submitMetadataPublication(prepared, signature, { publicClient: chain(false) }), code("SIGNATURE_REJECTED"));
  assert.equal(svc.posts().length, 2);
});
test("preparation asks only for what it lacks: the epoch and controller from chain skip the publisher lookup, the revision and time can be given, and an eoa creator signs the message", async () => {
  const controller = privateKeyToAccount(generatePrivateKey()), svc = service({ revision: 7 }), meta = client(svc);
  const given = await meta.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, epoch: 4n, controller: controller.address, expectedRevision: 0, issuedAt: 1_700_000_000 });
  assert.equal(svc.calls.length, 0); assert.deepEqual([given.intent.expectedRevision, given.intent.issuedAt, given.epoch, given.signer], [0, 1_700_000_000, 4n, controller.address.toLowerCase()]);
  // Only the time is fetched when the revision is given; the revision is read when it is not.
  await meta.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, epoch: 0n, expectedRevision: 3 });
  assert.deepEqual(svc.calls.map(call => call.url.pathname), ["/api/elysium/token-images"]);
  assert.equal((await meta.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, epoch: 0n })).intent.expectedRevision, 7);
  // The clock is the service's, advanced by monotonic time only.
  let age = 0; const ticking = client(service(), { elapsed: () => age });
  await ticking.serverTime(); age = 12_500; assert.equal(await ticking.serverTime(), SERVER_TIME + 13);
  // A sample older than a minute is not trusted: the clock is read again.
  age = 61_000; assert.equal(await ticking.serverTime(), SERVER_TIME);
  // A creator that is a plain wallet signs the message itself.
  const plain = privateKeyToAccount(generatePrivateKey()), eoa = service({ kind: "eoa", controller: ACCOUNT, revision: undefined });
  const prepared = await client(eoa).prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields });
  assert.deepEqual([prepared.signing.method, prepared.signer, prepared.epoch], ["personal_sign", ACCOUNT, null]);
  assert.equal(prepared.signing.method === "personal_sign" ? prepared.signing.message : "", prepared.message);
  assert.equal(prepared.intent.expectedRevision, 0, "nothing saved yet");
  const wrongWallet = await plain.signMessage({ message: prepared.message });
  await assert.rejects(client(eoa).submitMetadataPublication(prepared, wrongWallet), code("SIGNER_MISMATCH"));
  // Authority the SDK cannot sign for is refused rather than guessed at: another generation, another chain, an account that changed.
  for (const [label, publisher] of [["generation", { publication: { generation: "gen9", chainId: 99801, account: ACCOUNT, epoch: "0" } }], ["chain", { publication: { generation: "gen10", chainId: 1, account: ACCOUNT, epoch: "0" } }],
    ["account", { publication: { generation: "gen10", chainId: 99801, account: addr(9), epoch: "0" } }], ["epoch", { publication: { generation: "gen10", chainId: 99801, account: ACCOUNT, epoch: "-1" } }], ["none", {}]] as const) {
    const odd = createOxleyMetadataClient({ elapsed: () => 0, fetch: async () => new Response(JSON.stringify({ publisher: { dealId: DEAL, coin: COIN, creator: ACCOUNT, controller: ACCOUNT, ...publisher } }), { headers: { date: SERVER_DATE } }) });
    await assert.rejects(odd.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, expectedRevision: 0, issuedAt: 1 }), code("PUBLICATION_AUTHORITY_CHANGED"), label);
  }
  // Inputs are validated before anything is requested.
  const quiet = service(), strict = client(quiet);
  await assert.rejects(strict.prepareMetadataPublication({ dealId: "0x12", coin: COIN, creator: ACCOUNT, metadata: fields }), code("INVALID_HASH"));
  await assert.rejects(strict.prepareMetadataPublication({ dealId: DEAL, coin: addr(0), creator: ACCOUNT, metadata: fields }), code("INVALID_ADDRESS"));
  await assert.rejects(strict.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: { ...fields, website: "http://x.test" } }), code("INVALID_LINK"));
  await assert.rejects(strict.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, expectedRevision: -1, epoch: 0n }), code("INVALID_INTENT"));
  await assert.rejects(strict.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, epoch: 0n, controller: "nope" }), code("INVALID_ADDRESS"));
  await assert.rejects(strict.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, epoch: -1n }), code("INVALID_EPOCH"));
  await assert.rejects(strict.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, epoch: 1 as never }), code("INVALID_EPOCH"));
  await assert.rejects(strict.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields, epoch: 0n, issuedAt: 1.5 }), code("INVALID_INTENT"));
  assert.equal(quiet.calls.length, 0);
});
test("a save is retried quietly with the same signature when the service is busy, and every refusal keeps the service's own code", async () => {
  const controller = privateKeyToAccount(generatePrivateKey()), waits: number[] = [];
  const outcomes: Response[] = [];
  const busy = (status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: "Token details are busy. Try again shortly.", code: "CAPACITY_LIMITED", requestId: "req-1" }), { status, headers });
  const svc = service({ revision: 0, controller: controller.address, post: (_, attempt) => attempt === 1 ? busy(429, { "retry-after": "3" }) : attempt === 2 ? busy(503) : undefined });
  const meta = client(svc, { sleep: async ms => { waits.push(ms); } });
  const prepared = await meta.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields });
  const signature = await controller.signTypedData((prepared.signing as { typedData: ReturnType<typeof publicationTypedData> }).typedData);
  assert.equal((await meta.submitMetadataPublication(prepared, signature)).revision, 1);
  assert.deepEqual(waits, [3_000, 2_000]); assert.equal(svc.posts().length, 3);
  assert.equal(new Set(svc.posts().map(call => String(call.body))).size, 1, "the same signed body every time");
  // Refusals are final and carry the service's code, its message, the request id and the retry hint.
  const refusals: [number, string, string][] = [[401, "SIGNATURE_EXPIRED", "This signature expired. Sign again."], [403, "NOT_CREATOR", "Only the current creator controller can edit these details."],
    [409, "DETAILS_CHANGED", "These details changed. Open Edit again."], [400, "SIGNATURE_UNSUPPORTED", "This wallet returned a smart-account signature."], [403, "ORIGIN_MISMATCH", "Open oxley to edit these details."]];
  for (const [status, serviceCode, message] of refusals) {
    const refused = service({ revision: 0, controller: controller.address, post: () => new Response(JSON.stringify({ error: message, code: serviceCode, requestId: "req-9" }), { status }) });
    await assert.rejects(client(refused).submitMetadataPublication(prepared, signature), (error: unknown) => error instanceof OxleyError && error.code === serviceCode && error.message === message
      && error.details?.status === status && error.details.requestId === "req-9");
    assert.equal(refused.posts().length, 1, serviceCode);
  }
  // The retry budget ends in the last answer; a body that is not an error object still carries the status.
  const down = service({ revision: 0, controller: controller.address, post: () => new Response("<html>", { status: 502 }) });
  await assert.rejects(client(down).submitMetadataPublication(prepared, signature), (error: unknown) => error instanceof OxleyError && error.code === "HTTP_ERROR" && error.details?.status === 502);
  assert.equal(down.posts().length, 6);
  // A network failure is a coded error without the URL's query.
  const offline = createOxleyMetadataClient({ elapsed: () => 0, sleep: async () => undefined, retry: { attempts: 2 }, fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(offline.readTokenMetadata([DEAL]), (error: unknown) => error instanceof OxleyError && error.code === "NETWORK_ERROR");
  // The service accepted the save but its echo does not confirm it: say so, never report a failed save.
  for (const echo of [{ item: undefined }, { item: { chainId: 99801, dealId: DEAL, coin: COIN, creator: ACCOUNT, revision: 5, updatedAt: 1, metadata: fields } }]) {
    const unclear = service({ revision: 0, controller: controller.address, post: () => new Response(JSON.stringify(echo), { headers: { date: SERVER_DATE } }) });
    await assert.rejects(client(unclear).submitMetadataPublication(prepared, signature), code("COMMIT_UNCONFIRMED"));
  }
  void outcomes;
});
test("reads need no origin: any number of deals in batches of 50, invalid answers refused, and a token resolved from its deal id", async () => {
  const svc = service({ revision: 1 }), meta = client(svc), ids = Array.from({ length: 120 }, (_, i) => toHex(i + 1, { size: 32 }));
  const items = await meta.readTokenMetadata([...ids, ids[0]!.toUpperCase().replace("0X", "0x")]);
  assert.equal(items.length, 120); assert.deepEqual(svc.calls.map(call => call.url.searchParams.get("ids")!.split(",").length), [50, 50, 20]);
  assert.ok(svc.calls.every(call => call.headers.origin === undefined && call.method === "GET"));
  await assert.rejects(meta.readTokenMetadata([]), code("INVALID_HASH")); await assert.rejects(meta.readTokenMetadata(["0x12"]), code("INVALID_HASH"));
  const invalid = createOxleyMetadataClient({ fetch: async () => new Response(JSON.stringify({ items: [{ dealId: DEAL, coin: COIN, creator: ACCOUNT, revision: 0, updatedAt: 1, chainId: 99801, metadata: fields }] })) });
  await assert.rejects(invalid.readTokenMetadata([DEAL]), code("INVALID_RESPONSE"));
  assert.deepEqual(await meta.resolveToken(DEAL), { dealId: DEAL, coin: COIN, creator: ACCOUNT, cid: null, nativeGeneration: "gen10" });
  await assert.rejects(meta.resolveToken("nope"), code("INVALID_HASH"));
});
test("an image is published once, signed like the details: the multipart request carries the image, its intent and the signature, and the service's CID comes back", async () => {
  const controller = privateKeyToAccount(generatePrivateKey()), svc = service({ controller: controller.address, epoch: "0" }), meta = client(svc), image = png(512, 512);
  const prepared = await meta.prepareImagePublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, image });
  assert.deepEqual(prepared.intent, { chainId: 99801, dealId: DEAL, coin: COIN, creator: ACCOUNT, imageHash: sha(image), origin: OXLEY_APP_URL, issuedAt: SERVER_TIME });
  assert.deepEqual([prepared.purpose, prepared.image.mime, prepared.image.width, prepared.expiresAt, prepared.message], ["image", "image/png", 512, SERVER_TIME + 600, tokenImageMessage(prepared.intent)]);
  if (prepared.signing.method !== "eth_signTypedData_v4") throw new Error("typed data expected");
  assert.deepEqual(prepared.signing.typedData.message.purpose, PUBLICATION_PURPOSE.image);
  assert.equal(prepared.signing.typedData.message.payloadHash, hashMessage(tokenImageMessage(prepared.intent)));
  const signature = await controller.signTypedData(prepared.signing.typedData), published = await meta.submitImagePublication(prepared, signature);
  assert.deepEqual(published, { cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" });
  const post = svc.posts()[0]!, form = post.body as FormData;
  assert.deepEqual([post.url.pathname, post.headers.origin, post.headers["content-type"]], ["/api/elysium/token-images", "https://app.oxley.fun", undefined]);
  assert.ok(form instanceof FormData); assert.deepEqual(JSON.parse(String(form.get("intent"))), prepared.intent); assert.equal(form.get("signature"), signature);
  const file = form.get("image") as File;
  assert.deepEqual([file.type, file.size, sha(new Uint8Array(await file.arrayBuffer()))], ["image/png", image.length, sha(image)]);
  // Not the controller's signature, a bad image, or an answer without a CID.
  await assert.rejects(meta.submitImagePublication(prepared, await privateKeyToAccount(generatePrivateKey()).signTypedData(prepared.signing.typedData)), code("SIGNER_MISMATCH"));
  await assert.rejects(meta.prepareImagePublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, image: new Uint8Array(900_001) }), code("IMAGE_TOO_LARGE"));
  const noCid = service({ controller: controller.address, epoch: "0", post: () => new Response(JSON.stringify({ cid: "not-a-cid" }), { headers: { date: SERVER_DATE } }) });
  await assert.rejects(client(noCid).submitImagePublication(prepared, signature), code("INVALID_RESPONSE"));
  // A busy service is tried three times for an image (a signed upload is idempotent: a stored image returns its CID), a refusal once.
  const busy = service({ controller: controller.address, epoch: "0", post: () => new Response("{}", { status: 503 }) });
  await assert.rejects(client(busy).submitImagePublication(prepared, signature), code("HTTP_ERROR")); assert.equal(busy.posts().length, 3);
});
test("the base URL is the application root: production by default, any HTTPS root (an HTTP one on localhost), and the intent names that origin", async () => {
  assert.equal(createOxleyMetadataClient().origin, "https://app.oxley.fun");
  for (const baseUrl of ["https://preview.example.test", "https://preview.example.test/", "http://localhost:3000", "http://127.0.0.1:8080"]) assert.doesNotThrow(() => createOxleyMetadataClient({ baseUrl }), baseUrl);
  for (const baseUrl of ["http://app.oxley.fun", "https://app.oxley.fun/api/data/v1", "https://app.oxley.fun?x=1", "https://user:pass@app.oxley.fun", "ftp://x.test", "not a url", "https://app.oxley.fun/#x"]) {
    assert.throws(() => createOxleyMetadataClient({ baseUrl }), code("INVALID_BASE_URL"), baseUrl);
  }
  const svc = service({ revision: 0, epoch: "0" }), custom = createOxleyMetadataClient({ baseUrl: "https://preview.example.test", fetch: svc.fetch, elapsed: () => 0 });
  const prepared = await custom.prepareMetadataPublication({ dealId: DEAL, coin: COIN, creator: ACCOUNT, metadata: fields });
  assert.equal(prepared.intent.origin, "https://preview.example.test"); assert.ok(svc.calls.every(call => call.url.origin === "https://preview.example.test"));
  assert.match(prepared.message, /^Update token description and links on oxley\nWebsite: https:\/\/preview\.example\.test\n/u);
});
test("the entry point exports the publication API and nothing that holds a key", () => {
  assert.deepEqual(Object.keys(metadata).sort(), ["IMAGE_SIGNATURE_MAX_AGE_SECONDS", "METADATA_SIGNATURE_MAX_AGE_SECONDS", "OXLEY_APP_URL", "PUBLICATION_DEADLINE_SECONDS", "PUBLICATION_PURPOSE", "TOKEN_DESCRIPTION_MAX",
    "TOKEN_IMAGE_MAX_BODY", "TOKEN_IMAGE_MAX_BYTES", "TOKEN_IMAGE_MAX_PIXELS", "TOKEN_LINK_MAX", "TOKEN_METADATA_BATCH", "TOKEN_METADATA_CHAIN", "TOKEN_METADATA_MAX_BODY", "createOxleyMetadataClient",
    "emptyTokenMetadata", "inspectTokenImage", "normalizePublicationSignature", "parseTokenImageIntent", "parseTokenMetadataFields", "parseTokenMetadataIntent", "publicationTypedData", "tokenImageCid",
    "tokenImageMessage", "tokenMetadataHash", "tokenMetadataMessage", "validTokenMetadataRecord", "validateTokenImage"]);
  assert.ok(!Object.keys(metadata).some(name => /sign(?!ature)|private|secret|mnemonic/i.test(name)));
});
