import { hashMessage, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex, type PublicClient } from "viem";
import { creatorAccountAbi } from "./launch-abis.js";
import { PUBLICATION_DEADLINE_SECONDS, PUBLICATION_PURPOSE, IMAGE_SIGNATURE_MAX_AGE_SECONDS, METADATA_SIGNATURE_MAX_AGE_SECONDS,
  TOKEN_METADATA_BATCH, TOKEN_METADATA_CHAIN, TOKEN_METADATA_MAX_BODY, normalizePublicationSignature, parseTokenMetadataFields, publicationTypedData, tokenImageCid,
  tokenImageMessage, tokenMetadataHash, tokenMetadataMessage, validTokenMetadataRecord, validateTokenImage, type TokenImageIntent, type TokenMetadataFields,
  type TokenMetadataIntent, type TokenMetadataRecord } from "./metadata-rules.js";
import { OxleyError, sameAddress } from "./validation.js";
export * from "./metadata-rules.js";

/** The production application that serves the token details routes the website uses. */
export const OXLEY_APP_URL = "https://app.oxley.fun";
const METADATA_ROUTE = "/api/elysium/token-metadata", IMAGE_ROUTE = "/api/elysium/token-images";
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const DEAL = /^0x[\da-f]{64}$/u, ADDRESS = /^0x[\da-f]{40}$/u;

export interface MetadataClientOptions {
  /** The application root, `https://app.oxley.fun` by default (HTTPS, or http on localhost). The signed intent names its origin, and the server accepts only its own. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Per request; default 30 s (a save takes up to 25 s on the server). */
  timeoutMs?: number;
  /** A signed save is idempotent for one revision, so transient answers (429, 500, 502, 503, 504) are retried with the same signature: 6 attempts within 45 s by default. */
  retry?: { attempts?: number; budgetMs?: number; minimumDelayMs?: number; maximumDelayMs?: number };
  /** Test seams: a monotonic clock in ms (default `performance.now`) and the sleep between retries. */
  elapsed?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
/** Who signs and how: the creator account's controller signs EIP-712 typed data (`account`), a plain wallet that is itself the creator signs the message (`message`). */
export type PublicationSigning =
  | { readonly method: "eth_signTypedData_v4"; readonly typedData: ReturnType<typeof publicationTypedData> }
  | { readonly method: "personal_sign"; readonly message: string };
export interface PublicationScope {
  readonly dealId: Hex; readonly coin: Address; readonly creator: Address;
  /** The wallet that controls the creator account now: the only signer the service accepts. */
  readonly controller: Address;
  /** `account`: signs typed data bound to `epoch`; `eoa`: the creator is a plain wallet and signs the message. */
  readonly kind: "account" | "eoa";
  readonly epoch: bigint | null;
}
interface Identity { dealId: Hex; coin: Address; creator: Address }
interface PreparedBase {
  readonly identity: Identity; readonly origin: string; readonly message: string; readonly signing: PublicationSigning;
  /** The wallet that must sign, when known (the creator account's controller); a signature by anyone else is refused before it is sent. */
  readonly signer: Address | null; readonly issuedAt: number;
  /** The server refuses the signature after this Unix time (its own clock); sign and submit before it. */
  readonly expiresAt: number; readonly purpose: "metadata" | "image"; readonly epoch: bigint | null;
}
export interface PreparedMetadataPublication extends PreparedBase {
  readonly purpose: "metadata"; readonly intent: TokenMetadataIntent; readonly metadata: TokenMetadataFields;
}
export interface PreparedImagePublication extends PreparedBase {
  readonly purpose: "image"; readonly intent: TokenImageIntent; readonly image: { readonly bytes: Uint8Array; readonly mime: string; readonly width: number; readonly height: number };
}
export interface PublicationInput {
  dealId: string; coin: string; creator: string;
  /** The creator account's `handoverCount`, which `getLaunch` reads from chain. Omit it and the service is asked (its answer is the same read, and a wrong one only makes the signature invalid). */
  epoch?: bigint;
  /** The creator account's current controller (`getLaunch().accountController`); with `epoch` it makes the signer known. */
  controller?: string;
  /** Unix seconds the signature is issued at; default: the service's clock (its `Date` header), never the device's. */
  issuedAt?: number;
}

function root(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? OXLEY_APP_URL); } catch { throw new OxleyError("INVALID_BASE_URL", "baseUrl must be the application root, like https://app.oxley.fun"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new OxleyError("INVALID_BASE_URL", "baseUrl must be the application root, like https://app.oxley.fun (no path, query or credentials; HTTPS except on localhost)");
  }
  return url.origin;
}
function identityOf(input: { dealId: string; coin: string; creator: string }): Identity {
  const [dealId, coin, creator] = [input?.dealId, input?.coin, input?.creator].map(value => typeof value === "string" ? value.toLowerCase() : "");
  if (!DEAL.test(dealId!) || BigInt(dealId!) === 0n) throw new OxleyError("INVALID_HASH", "dealId must be a nonzero bytes32");
  for (const value of [coin, creator]) if (!ADDRESS.test(value!) || BigInt(value!) === 0n) throw new OxleyError("INVALID_ADDRESS", "coin and creator must be nonzero addresses");
  return { dealId: dealId as Hex, coin: coin as Address, creator: creator as Address };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Publishes a token's description, links and image through Oxley's public token details service, for the creator account's controller. The SDK holds no key: it builds the
 * exact payload and the data the controller must sign (`prepare*`), and sends the signed payload (`submit*`). Publishing is a browser-origin-bound route: the intent names the
 * application's origin and the request must carry the same `Origin` header, which Node sets and a browser does not allow from another site, so this client publishes from
 * Node, bots and agents, or from the application's own pages. Reads need no origin.
 */
export function createOxleyMetadataClient(options: MetadataClientOptions = {}) {
  const origin = root(options.baseUrl), fetchFn = options.fetch ?? globalThis.fetch, timeoutMs = options.timeoutMs ?? 30_000;
  const elapsed = options.elapsed ?? (() => performance.now()), sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const retry = { attempts: 6, budgetMs: 45_000, minimumDelayMs: 1_000, maximumDelayMs: 8_000, ...options.retry };
  // The service's clock, learned from `Date` headers and advanced only by monotonic time, so a device clock that is fast or slow cannot expire a signature.
  let sample: { serverMs: number; observed: number } | undefined;
  const learn = (response: Response) => {
    const date = Date.parse(response.headers.get("date") ?? "");
    if (Number.isFinite(date)) sample = { serverMs: date + 500, observed: elapsed() };
  };
  const known = () => { const age = sample ? elapsed() - sample.observed : -1; return sample && age >= 0 && age <= 60_000 ? Math.floor((sample.serverMs + age) / 1000) : undefined; };

  async function failure(response: Response): Promise<OxleyError> {
    let body: Record<string, unknown> = {};
    try { const text = await response.text(); const value: unknown = text.length <= 16_384 ? JSON.parse(text) : null; if (record(value)) body = value; } catch { /* Status alone. */ }
    const retryAfter = Number(response.headers.get("retry-after")), message = typeof body.error === "string" && body.error.length >= 4 && body.error.length <= 240 ? body.error : `The service answered ${response.status}`;
    return new OxleyError(typeof body.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(body.code) ? body.code : "HTTP_ERROR", message,
      { status: response.status, requestId: typeof body.requestId === "string" ? body.requestId : response.headers.get("x-request-id"),
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 86_400) * 1000 : null });
  }
  async function send(path: string, init: RequestInit & { headers?: Record<string, string> } = {}, attempts = 1): Promise<Response> {
    const started = elapsed();
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined, cause: unknown;
      try { response = await fetchFn(`${origin}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) }); } catch (error) { cause = error; }
      if (response) { learn(response); if (response.ok) return response; }
      const error = response ? await failure(response) : new OxleyError("NETWORK_ERROR", `The token details service could not be reached: ${String((cause as Error)?.message ?? cause).split("\n")[0]}`);
      const wait = Math.min(retry.maximumDelayMs, Math.max(retry.minimumDelayMs, (error.details?.retryAfterMs as number | null) ?? attempt * retry.minimumDelayMs));
      if (attempt >= attempts || (response && !TRANSIENT.has(response.status)) || elapsed() - started + wait > retry.budgetMs) throw error;
      await sleep(wait);
    }
  }
  async function json(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (text.length > 1_048_576) throw new OxleyError("INVALID_RESPONSE", "The service's answer is too large");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new OxleyError("INVALID_RESPONSE", "The service's answer is not JSON"); }
    if (!record(value)) throw new OxleyError("INVALID_RESPONSE", "The service's answer is not an object");
    return value;
  }

  /** The service's current time in Unix seconds (from a `Date` header), the clock a signature's issue time is judged by. */
  async function serverTime(): Promise<number> {
    const now = known();
    if (now !== undefined) return now;
    await send(IMAGE_ROUTE);
    const learned = known();
    if (learned === undefined) throw new OxleyError("TIME_UNAVAILABLE", "The service did not report its time; pass issuedAt");
    return learned;
  }
  /** The saved details of up to any number of deals (50 per request); a deal with nothing saved is absent from the answer. */
  async function readTokenMetadata(dealIds: readonly string[]): Promise<TokenMetadataRecord[]> {
    const ids = [...new Set(dealIds.map(id => (typeof id === "string" ? id.toLowerCase() : "")))];
    if (!ids.length || ids.some(id => !DEAL.test(id))) throw new OxleyError("INVALID_HASH", "Each deal id must be a lowercase bytes32");
    const items: TokenMetadataRecord[] = [];
    for (let at = 0; at < ids.length; at += TOKEN_METADATA_BATCH) {
      const batch = ids.slice(at, at + TOKEN_METADATA_BATCH);
      const body = await json(await send(`${METADATA_ROUTE}?${new URLSearchParams({ ids: batch.join(",") })}`, {}, retry.attempts));
      const list = body.items;
      if (!Array.isArray(list) || list.length > 100 || !list.every(validTokenMetadataRecord) || list.some(item => !batch.includes(item.dealId))
        || new Set(list.map(item => `${item.dealId}:${item.coin}:${item.creator}`)).size !== list.length) throw new OxleyError("INVALID_RESPONSE", "The service returned invalid token details");
      items.push(...list);
    }
    return items;
  }
  /** The coin and creator account the service knows for a deal, and its image if any. Server-reported: for a signature take them from chain (`getLaunch`). */
  async function resolveToken(dealId: string) {
    const id = typeof dealId === "string" ? dealId.toLowerCase() : "";
    if (!DEAL.test(id)) throw new OxleyError("INVALID_HASH", "dealId must be a lowercase bytes32");
    const body = await json(await send(`${IMAGE_ROUTE}?${new URLSearchParams({ publication: id })}`, {}, retry.attempts));
    const item = Array.isArray(body.items) ? body.items.find((row): row is Record<string, unknown> => record(row) && row.dealId === id) : undefined;
    if (!item || typeof item.coin !== "string" || typeof item.creator !== "string" || !ADDRESS.test(item.coin) || !ADDRESS.test(item.creator)
      || (item.cid !== null && !(typeof item.cid === "string" && tokenImageCid.test(item.cid)))) throw new OxleyError("INVALID_RESPONSE", "The service returned no token for this deal");
    return { dealId: id as Hex, coin: item.coin as Address, creator: item.creator as Address, cid: item.cid as string | null,
      nativeGeneration: typeof item.nativeGeneration === "string" ? item.nativeGeneration : null };
  }
  /** Who may publish for a deal and how they sign, as the service reads it from chain: the creator account's controller and its handover epoch. */
  async function readPublisher(input: { dealId: string; coin: string; creator: string }): Promise<PublicationScope> {
    const who = identityOf(input);
    const body = await json(await send(`${IMAGE_ROUTE}?${new URLSearchParams({ publisher: who.dealId, coin: who.coin, creator: who.creator })}`, {}, retry.attempts));
    const publisher = body.publisher;
    if (!record(publisher) || String(publisher.dealId).toLowerCase() !== who.dealId || String(publisher.coin).toLowerCase() !== who.coin || String(publisher.creator).toLowerCase() !== who.creator
      || typeof publisher.controller !== "string" || !ADDRESS.test(publisher.controller.toLowerCase())) throw new OxleyError("PUBLICATION_AUTHORITY_CHANGED", "Publication authority changed or is unavailable; try again");
    const controller = publisher.controller.toLowerCase() as Address;
    if (publisher.publicationKind === "eoa" && sameAddress(controller, who.creator)) return Object.freeze({ ...who, controller, kind: "eoa" as const, epoch: null });
    const scope = publisher.publication;
    if (!record(scope) || scope.chainId !== TOKEN_METADATA_CHAIN || String(scope.account).toLowerCase() !== who.creator || scope.generation !== "gen10"
      || typeof scope.epoch !== "string" || !/^(0|[1-9]\d{0,77})$/u.test(scope.epoch) || BigInt(scope.epoch) >= 1n << 256n) {
      throw new OxleyError("PUBLICATION_AUTHORITY_CHANGED", "This deal's publication authority is not a Gen10 creator account the SDK can sign for");
    }
    return Object.freeze({ ...who, controller, kind: "account" as const, epoch: BigInt(scope.epoch) });
  }
  /** The shape of what the caller supplied about who signs, checked before anything is requested. */
  function checkScope(input: PublicationInput) {
    if (input.epoch !== undefined && (typeof input.epoch !== "bigint" || input.epoch < 0n || input.epoch >= 1n << 256n)) throw new OxleyError("INVALID_EPOCH", "The handover epoch must be a uint256");
    if (input.controller !== undefined && !(typeof input.controller === "string" && ADDRESS.test(input.controller.toLowerCase()) && BigInt(input.controller) > 0n)) {
      throw new OxleyError("INVALID_ADDRESS", "controller must be a nonzero address");
    }
    if (input.issuedAt !== undefined && !(Number.isSafeInteger(input.issuedAt) && input.issuedAt >= 0)) throw new OxleyError("INVALID_INTENT", "issuedAt must be a Unix time in seconds");
  }
  async function scopeOf(who: Identity, input: PublicationInput) {
    if (input.epoch !== undefined) return { kind: "account" as const, epoch: input.epoch, controller: input.controller ? input.controller.toLowerCase() as Address : null };
    const scope = await readPublisher(who);
    return { kind: scope.kind, epoch: scope.epoch, controller: scope.controller };
  }
  const signingOf = (purpose: "metadata" | "image", who: Identity, message: string, scope: Awaited<ReturnType<typeof scopeOf>>, issuedAt: number): PublicationSigning =>
    scope.kind === "eoa" ? { method: "personal_sign", message }
      : { method: "eth_signTypedData_v4", typedData: publicationTypedData({ creatorAccount: who.creator, purpose, message, epoch: scope.epoch!, issuedAt }) };

  /**
   * Builds the exact request for new details (all four fields; an empty one clears it) and the data to sign. `expectedRevision` defaults to the saved revision (0 when
   * nothing is saved): a save against a stale revision is refused (`DETAILS_CHANGED`), so two writers cannot overwrite each other. The result must be signed by
   * `signer`, the creator account's controller, and sent within about nine minutes (`expiresAt`).
   */
  async function prepareMetadataPublication(input: PublicationInput & { metadata: TokenMetadataFields; expectedRevision?: number }): Promise<PreparedMetadataPublication> {
    const who = identityOf(input), metadata = parseTokenMetadataFields(input.metadata);
    checkScope(input);
    if (input.expectedRevision !== undefined && !(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0)) throw new OxleyError("INVALID_INTENT", "expectedRevision must be a non-negative integer");
    const expectedRevision = input.expectedRevision ?? (await readTokenMetadata([who.dealId])).find(item => item.coin === who.coin && item.creator === who.creator)?.revision ?? 0;
    const issuedAt = input.issuedAt ?? await serverTime(), scope = await scopeOf(who, input);
    const intent: TokenMetadataIntent = { chainId: TOKEN_METADATA_CHAIN, ...who, metadataHash: tokenMetadataHash(metadata), expectedRevision, origin, issuedAt };
    const message = tokenMetadataMessage(intent);
    return Object.freeze({ purpose: "metadata" as const, identity: who, origin, intent, metadata, message, signing: signingOf("metadata", who, message, scope, issuedAt),
      signer: scope.kind === "eoa" ? who.creator : scope.controller, issuedAt, expiresAt: issuedAt + METADATA_SIGNATURE_MAX_AGE_SECONDS, epoch: scope.epoch });
  }
  /** Builds the request for a token image (PNG, JPEG or WebP, up to 900 KB; the service stores it once, as a 512 x 512 WebP, permanently) and the data to sign. */
  async function prepareImagePublication(input: PublicationInput & { image: Uint8Array }): Promise<PreparedImagePublication> {
    const who = identityOf(input), image = validateTokenImage(input.image);
    checkScope(input);
    const issuedAt = input.issuedAt ?? await serverTime(), scope = await scopeOf(who, input);
    const intent: TokenImageIntent = { chainId: TOKEN_METADATA_CHAIN, ...who, imageHash: image.imageHash, origin, issuedAt };
    const message = tokenImageMessage(intent);
    return Object.freeze({ purpose: "image" as const, identity: who, origin, intent, image: { bytes: image.bytes, mime: image.mime, width: image.width, height: image.height }, message,
      signing: signingOf("image", who, message, scope, issuedAt), signer: scope.kind === "eoa" ? who.creator : scope.controller, issuedAt,
      expiresAt: issuedAt + IMAGE_SIGNATURE_MAX_AGE_SECONDS, epoch: scope.epoch });
  }
  /** Checks a signature the way the service will before sending it: the signer is the expected controller and, with a public client, the creator account accepts it on chain. */
  async function verifySignature(prepared: PreparedMetadataPublication | PreparedImagePublication, signature: Hex, publicClient?: Pick<PublicClient, "readContract">) {
    if (prepared.signing.method === "personal_sign") {
      const signer = await recoverMessageAddress({ message: prepared.signing.message, signature }).catch(() => null);
      if (!signer || (prepared.signer && !sameAddress(signer, prepared.signer))) throw new OxleyError("SIGNER_MISMATCH", "The signature is not the creator's");
      return;
    }
    const typed = prepared.signing.typedData, signer = await recoverTypedDataAddress({ ...typed, signature }).catch(() => null);
    if (!signer || (prepared.signer && !sameAddress(signer, prepared.signer))) throw new OxleyError("SIGNER_MISMATCH", "The signature is not the creator account controller's");
    if (!publicClient) return;
    const accepted = await publicClient.readContract({ address: prepared.identity.creator, abi: creatorAccountAbi, functionName: "isValidPublicationSignature",
      args: [PUBLICATION_PURPOSE[prepared.purpose], hashMessage(prepared.message), prepared.epoch!, BigInt(prepared.issuedAt + PUBLICATION_DEADLINE_SECONDS), signature] });
    if (!accepted) throw new OxleyError("SIGNATURE_REJECTED", "The creator account does not accept this signature (wrong signer, epoch or deadline)");
  }
  const origins = (extra: Record<string, string> = {}) => ({ origin, ...extra });

  /** Sends the signed details. Resolves with the stored record (revision + 1); a save the service accepted but could not echo is `COMMIT_UNCONFIRMED` (read the record to see it). */
  async function submitMetadataPublication(prepared: PreparedMetadataPublication, signature: string, submit: { publicClient?: Pick<PublicClient, "readContract"> } = {}) {
    const signed = normalizePublicationSignature(signature);
    await verifySignature(prepared, signed, submit.publicClient);
    const body = JSON.stringify({ intent: prepared.intent, metadata: prepared.metadata, signature: signed });
    if (body.length > TOKEN_METADATA_MAX_BODY) throw new OxleyError("INVALID_METADATA", "The request is larger than the service accepts");
    const result = await json(await send(METADATA_ROUTE, { method: "POST", headers: origins({ "content-type": "application/json" }), body }, retry.attempts)), item = result.item;
    if (!validTokenMetadataRecord(item) || item.dealId !== prepared.intent.dealId || item.coin !== prepared.intent.coin || item.creator !== prepared.intent.creator
      || item.revision !== prepared.intent.expectedRevision + 1 || tokenMetadataHash(item.metadata) !== prepared.intent.metadataHash) {
      throw new OxleyError("COMMIT_UNCONFIRMED", "The save is not confirmed yet; read the token's details to check");
    }
    return item;
  }
  /** Sends the signed image. The service stores one image per token, once: if one is already stored its CID is returned and nothing changes. Resolves with the CID. */
  async function submitImagePublication(prepared: PreparedImagePublication, signature: string, submit: { publicClient?: Pick<PublicClient, "readContract"> } = {}) {
    const signed = normalizePublicationSignature(signature);
    await verifySignature(prepared, signed, submit.publicClient);
    const form = new FormData();
    form.set("image", new Blob([prepared.image.bytes as Uint8Array<ArrayBuffer>], { type: prepared.image.mime }), `token.${prepared.image.mime.split("/")[1]}`);
    form.set("intent", JSON.stringify(prepared.intent)); form.set("signature", signed);
    const result = await json(await send(IMAGE_ROUTE, { method: "POST", headers: origins(), body: form }, 3));
    if (typeof result.cid !== "string" || !tokenImageCid.test(result.cid)) throw new OxleyError("INVALID_RESPONSE", "The service returned no image CID");
    return { cid: result.cid };
  }
  return { origin, serverTime, readTokenMetadata, resolveToken, readPublisher, prepareMetadataPublication, submitMetadataPublication, prepareImagePublication, submitImagePublication, verifySignature };
}
export type OxleyMetadataClient = ReturnType<typeof createOxleyMetadataClient>;
