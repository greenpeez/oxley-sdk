import { hashMessage, isAddress, keccak256, sha256, stringToHex, toBytes, type Address, type Hex } from "viem";
import { OxleyError } from "./validation.js";

/**
 * The token details service validates what a creator publishes exactly as these rules do: they mirror the application's shared validators
 * (`token-metadata`, `token-image`) and its server, field for field, so a payload that passes here is not refused for its shape. The server stays the authority.
 */
export const TOKEN_METADATA_CHAIN = 99801;
export const TOKEN_METADATA_BATCH = 50;
export const TOKEN_METADATA_MAX_BODY = 16_384;
export const TOKEN_DESCRIPTION_MAX = 2_000;
export const TOKEN_LINK_MAX = 512;
export const TOKEN_IMAGE_MAX_BYTES = 900_000;
/** The server refuses a multipart body over this size (the image plus the form fields). */
export const TOKEN_IMAGE_MAX_BODY = 920_000;
/** The server decodes at most this many pixels (`limitInputPixels`) and publishes a 512 x 512 WebP. */
export const TOKEN_IMAGE_MAX_PIXELS = 16_000_000;
/** The signed time must lie inside the server's window around its own clock: metadata 590 s behind to 25 s ahead, images 600 s behind to 30 s ahead. */
export const METADATA_SIGNATURE_MAX_AGE_SECONDS = 590;
export const IMAGE_SIGNATURE_MAX_AGE_SECONDS = 600;
/** The creator account accepts a typed publication signature until `issuedAt + 600` (its `deadline`, compared with the chain's time). */
export const PUBLICATION_DEADLINE_SECONDS = 600;
export const tokenImageCid = /^(?:b[a-z2-7]{20,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

export interface TokenMetadataFields { description: string; website: string; x: string; telegram: string }
export interface TokenMetadataIntent {
  chainId: number; dealId: string; coin: string; creator: string; metadataHash: string; expectedRevision: number; origin: string; issuedAt: number;
}
export interface TokenMetadataRecord {
  chainId: number; dealId: string; coin: string; creator: string; revision: number; updatedAt: number; metadata: TokenMetadataFields;
}
export interface TokenImageIntent { chainId: number; dealId: string; coin: string; creator: string; imageHash: string; origin: string; issuedAt: number }

const FIELDS = ["description", "website", "x", "telegram"] as const;
const address = /^0x[\da-f]{40}$/u, deal = /^0x[\da-f]{64}$/u, digest = /^[\da-f]{64}$/u;
const fail = (code: string, message: string): never => { throw new OxleyError(code, message); };

export const emptyTokenMetadata = (): TokenMetadataFields => ({ description: "", website: "", x: "", telegram: "" });
function exactly(value: unknown, keys: readonly string[], code: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(code, message);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) return fail(code, message);
  return row;
}
function invalidControl(value: string, allowLines = false): boolean {
  return Array.from(value).some(character => {
    const point = character.codePointAt(0)!;
    return point === 127 || point < 32 && !(allowLines && [9, 10, 13].includes(point));
  });
}
function httpsUrl(value: string): URL {
  if (invalidControl(value) || value.includes(" ")) return fail("INVALID_LINK", "Enter a valid HTTPS link.");
  let url: URL;
  try { url = new URL(value); } catch { return fail("INVALID_LINK", "Enter a valid HTTPS link."); }
  if (url.protocol !== "https:" || url.username || url.password) return fail("INVALID_LINK", "Enter a valid HTTPS link.");
  return url;
}
function link(value: unknown, field: "website" | "x" | "telegram"): string {
  if (typeof value !== "string" || value.length > TOKEN_LINK_MAX) return fail("INVALID_LINK", "Keep each link within 512 characters.");
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = httpsUrl(trimmed), host = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (field === "x" && !["x.com", "twitter.com"].includes(host)) return fail("INVALID_LINK", "Use an x.com or twitter.com link.");
  if (field === "telegram" && host !== "t.me") return fail("INVALID_LINK", "Use a t.me link.");
  if (url.href.length > TOKEN_LINK_MAX) return fail("INVALID_LINK", "Keep each link within 512 characters.");
  return url.href;
}
/**
 * The editable details of a token: a description (up to 2,000 characters; control characters other than tab and line breaks are refused) and three links (HTTPS; `x` on
 * x.com or twitter.com; `telegram` on t.me; each up to 512 characters, normalized by the URL parser). The name, ticker and every financial term are on chain and cannot be
 * edited: any other field is refused. Returns the canonical value the server stores and hashes.
 */
export function parseTokenMetadataFields(value: unknown): TokenMetadataFields {
  const row = exactly(value, FIELDS, "INVALID_METADATA", "Invalid token details.");
  if (typeof row.description !== "string" || row.description.length > TOKEN_DESCRIPTION_MAX || invalidControl(row.description, true)) {
    return fail("INVALID_DESCRIPTION", "Keep the description within 2,000 characters.");
  }
  return { description: row.description.replace(/\r\n?/gu, "\n").trim(), website: link(row.website, "website"), x: link(row.x, "x"), telegram: link(row.telegram, "telegram") };
}
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
/** SHA-256 (lowercase hex, no prefix) of the canonical JSON of the details: what the intent commits to. */
export const tokenMetadataHash = (fields: TokenMetadataFields): string => hex(sha256(toBytes(JSON.stringify(parseTokenMetadataFields(fields))), "bytes"));
function identity(row: Record<string, unknown>): boolean {
  return row.chainId === TOKEN_METADATA_CHAIN && typeof row.dealId === "string" && deal.test(row.dealId) && typeof row.coin === "string" && address.test(row.coin)
    && BigInt(row.coin) > 0n && typeof row.creator === "string" && address.test(row.creator) && BigInt(row.creator) > 0n;
}
const revision = (value: unknown, minimum: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value < Number.MAX_SAFE_INTEGER;
function httpsOrigin(value: unknown, allowHttp: boolean): string {
  if (typeof value !== "string" || value.length > 200) return fail("INVALID_ORIGIN", "Invalid publication origin.");
  let url: URL;
  try { url = new URL(value); } catch { return fail("INVALID_ORIGIN", "Invalid publication origin."); }
  if (!(url.protocol === "https:" || (allowHttp && url.protocol === "http:")) || url.username || url.password || url.origin !== value) return fail("INVALID_ORIGIN", "Invalid publication origin.");
  return value;
}
export function parseTokenMetadataIntent(value: unknown): TokenMetadataIntent {
  const row = exactly(value, ["chainId", "dealId", "coin", "creator", "metadataHash", "expectedRevision", "origin", "issuedAt"], "INVALID_INTENT", "Invalid metadata authorization.");
  if (!identity(row) || typeof row.metadataHash !== "string" || !digest.test(row.metadataHash) || !revision(row.expectedRevision, 0) || !revision(row.issuedAt, 0)) {
    return fail("INVALID_INTENT", "Invalid metadata authorization.");
  }
  httpsOrigin(row.origin, false);
  return row as unknown as TokenMetadataIntent;
}
/** The text the creator authorizes: it names the site, the chain, the deal, the content hash, the revision and the time, and authorizes no payment or approval. */
export function tokenMetadataMessage(intent: TokenMetadataIntent): string {
  const item = parseTokenMetadataIntent(intent);
  return ["Update token description and links on oxley", `Website: ${item.origin}`, `Chain: ${item.chainId}`, `Deal: ${item.dealId}`, `Coin: ${item.coin}`,
    `Creator account: ${item.creator}`, `Metadata SHA-256: ${item.metadataHash}`, `Expected revision: ${item.expectedRevision}`, `Issued at: ${item.issuedAt}`,
    "I authorize public publication of these token details.",
    "This signature authorizes no payment, token approval, or change to onchain identity or auction terms."].join("\n");
}
export function validTokenMetadataRecord(value: unknown): value is TokenMetadataRecord {
  try {
    const row = exactly(value, ["chainId", "dealId", "coin", "creator", "revision", "updatedAt", "metadata"], "INVALID_METADATA", "Invalid token details.");
    const normalized = parseTokenMetadataFields(row.metadata), metadata = row.metadata as Record<string, unknown>;
    return identity(row) && revision(row.revision, 1) && revision(row.updatedAt, 0) && FIELDS.every(field => normalized[field] === metadata[field]);
  } catch { return false; }
}

export function parseTokenImageIntent(value: unknown): TokenImageIntent {
  const bad = "Invalid image authorization.";
  const row = exactly(value, ["chainId", "dealId", "coin", "creator", "imageHash", "origin", "issuedAt"], "INVALID_INTENT", bad);
  if (!identity(row) || typeof row.imageHash !== "string" || !digest.test(row.imageHash) || typeof row.issuedAt !== "number" || !Number.isSafeInteger(row.issuedAt)) return fail("INVALID_INTENT", bad);
  httpsOrigin(row.origin, true);
  return row as unknown as TokenImageIntent;
}
export function tokenImageMessage(item: TokenImageIntent): string {
  parseTokenImageIntent(item);
  return ["Publish token image on oxley", `Website: ${item.origin}`, `Chain: ${item.chainId}`, `Deal: ${item.dealId}`, `Coin: ${item.coin}`, `Creator: ${item.creator}`,
    `Image SHA-256: ${item.imageHash}`, `Issued at: ${item.issuedAt}`,
    "I authorize permanent public publication of this image and its write-once token association.",
    "I own or have permission to use this image. This signature authorizes no payment or token approval."].join("\n");
}

export interface TokenImageInfo { readonly format: "png" | "jpeg" | "webp"; readonly mime: "image/png" | "image/jpeg" | "image/webp"; readonly width: number; readonly height: number; readonly animated: boolean }
const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
const be32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const le24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.slice(o, o + n));
function pngInfo(b: Uint8Array): TokenImageInfo | null {
  if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") return null;
  let animated = false;
  for (let offset = 8; offset + 8 <= b.length;) {
    const type = ascii(b, offset + 4, 4);
    if (type === "acTL") animated = true;
    if (type === "IDAT") break;
    offset += 12 + be32(b, offset);
  }
  return { format: "png", mime: MIME.png, width: be32(b, 16), height: be32(b, 20), animated };
}
function jpegInfo(b: Uint8Array): TokenImageInfo | null {
  for (let offset = 2; offset + 9 <= b.length;) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { format: "jpeg", mime: MIME.jpeg, height: (b[offset + 5]! << 8) | b[offset + 6]!, width: (b[offset + 7]! << 8) | b[offset + 8]!, animated: false };
    }
    offset += 2 + ((b[offset + 2]! << 8) | b[offset + 3]!);
  }
  return null;
}
function webpInfo(b: Uint8Array): TokenImageInfo | null {
  if (b.length < 30) return null;
  const kind = ascii(b, 12, 4);
  const make = (width: number, height: number, animated: boolean): TokenImageInfo => ({ format: "webp", mime: MIME.webp, width, height, animated });
  if (kind === "VP8X") return make(le24(b, 24) + 1, le24(b, 27) + 1, (b[20]! & 0x02) !== 0);
  if (kind === "VP8 ") return make(((b[27]! << 8) | b[26]!) & 0x3fff, ((b[29]! << 8) | b[28]!) & 0x3fff, false);
  if (kind === "VP8L" && b[20] === 0x2f) { const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24); return make((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, false); }
  return null;
}
/** The format and size of a PNG, JPEG or WebP read from its header, or null for anything else. Pure; decodes no pixels. */
export function inspectTokenImage(bytes: Uint8Array): TokenImageInfo | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return pngInfo(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegInfo(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpInfo(bytes);
  return null;
}
/**
 * The upload rules of the image route: a PNG, JPEG or WebP of 1 to 900,000 bytes, one frame, at most 16 million pixels (the server converts it to a 512 x 512 WebP and pins
 * it once, forever). The checks that need decoding (a corrupt file) stay with the server.
 */
export function validateTokenImage(bytes: Uint8Array): TokenImageInfo & { bytes: Uint8Array; imageHash: string } {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return fail("INVALID_IMAGE", "Choose a PNG, JPG, or WebP image under 900 KB.");
  if (bytes.length > TOKEN_IMAGE_MAX_BYTES) return fail("IMAGE_TOO_LARGE", "The image is too large: choose a PNG, JPG, or WebP image under 900 KB.");
  const info = inspectTokenImage(bytes);
  if (!info || info.width < 1 || info.height < 1) return fail("INVALID_IMAGE", "Choose a PNG, JPG, or WebP image under 900 KB.");
  if (info.animated) return fail("IMAGE_ANIMATED", "Animated images are not accepted: choose a single-frame image.");
  if (info.width * info.height > TOKEN_IMAGE_MAX_PIXELS) return fail("IMAGE_TOO_LARGE", "The image has more than 16 million pixels: choose a smaller image.");
  return { ...info, bytes, imageHash: hex(sha256(bytes, "bytes")) };
}

/** keccak256("OXLEY_TOKEN_IMAGE_GEN8") and keccak256("OXLEY_TOKEN_METADATA_GEN8"): the purposes a creator account's `isValidPublicationSignature` accepts. */
export const PUBLICATION_PURPOSE = Object.freeze({ image: keccak256(stringToHex("OXLEY_TOKEN_IMAGE_GEN8")), metadata: keccak256(stringToHex("OXLEY_TOKEN_METADATA_GEN8")) });
/**
 * The typed data a creator account's controller signs to publish for it (`OxleyCreatorPublication`, version 8, verified on chain by the account's
 * `isValidPublicationSignature`): the purpose, the EIP-191 hash of the message the server rebuilds, the account's handover epoch, and a deadline of `issuedAt + 600`.
 * The signature binds the account, the chain, the purpose, the content, the epoch and the deadline, so it replays nowhere else.
 */
export function publicationTypedData(input: { chainId?: number; creatorAccount: Address; purpose: keyof typeof PUBLICATION_PURPOSE; message: string; epoch: bigint; issuedAt: number }) {
  if (typeof input.epoch !== "bigint" || input.epoch < 0n || input.epoch >= 1n << 256n) return fail("INVALID_EPOCH", "The handover epoch must be a uint256");
  if (!isAddress(input.creatorAccount, { strict: false }) || BigInt(input.creatorAccount) === 0n) return fail("INVALID_ADDRESS", "The creator account must be a nonzero address");
  const deadline = BigInt(input.issuedAt + PUBLICATION_DEADLINE_SECONDS);
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0 || deadline >= 1n << 64n) return fail("INVALID_INTENT", "issuedAt must be a Unix time in seconds");
  return {
    domain: { name: "OxleyCreatorPublication", version: "8", chainId: BigInt(input.chainId ?? TOKEN_METADATA_CHAIN), verifyingContract: input.creatorAccount },
    types: { Publication: [{ name: "purpose", type: "bytes32" }, { name: "payloadHash", type: "bytes32" }, { name: "epoch", type: "uint256" }, { name: "deadline", type: "uint64" }] },
    primaryType: "Publication" as const,
    message: { purpose: PUBLICATION_PURPOSE[input.purpose], payloadHash: hashMessage(input.message), epoch: input.epoch, deadline },
  };
}
/** A wallet signature as the service takes it: 65 bytes, with `v` 27 or 28 (0 and 1 are the same signature and are converted, as the server does). Smart-account signatures are refused. */
export function normalizePublicationSignature(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x(?:[\da-f]{2})+$/iu.test(value)) return fail("SIGNATURE_INVALID", "Confirm the details in your wallet.");
  if (value.length !== 132) {
    return fail("SIGNATURE_UNSUPPORTED", "This wallet returned a smart-account or passkey signature, which token details cannot verify yet. Sign with the wallet account that controls the creator account.");
  }
  const v = Number.parseInt(value.slice(130), 16);
  if (v === 27 || v === 28) return value.toLowerCase() as Hex;
  if (v === 0 || v === 1) return `${value.slice(0, 130)}${(v + 27).toString(16)}`.toLowerCase() as Hex;
  return fail("SIGNATURE_INVALID", "Confirm the details in your wallet.");
}
