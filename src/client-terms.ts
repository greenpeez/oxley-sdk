import { encodeFunctionData, type Address, type Hex } from "viem";
import { termsRegistryAbi } from "./gen3-abis.js";
import { address, check, hash, OxleyError, uint } from "./validation.js";
import type { Anchor, Transaction } from "./types.js";
import type { ClientContext } from "./client-context.js";

/**
 * The caller's standing in the terms registry bound to a Gen3/Gen8 curve. Flat-fee and Gen2 curves have no terms:
 * `termsRegistry` is null and `accepted` is true. While the registry's `requiredVersion` is zero nothing is enforced.
 */
export interface TermsStatus extends Anchor {
  readonly account: Address;
  readonly termsRegistry: Address | null;
  /** The registry currently requires acceptance (`requiredVersion > 0`). */
  readonly enforced: boolean;
  readonly requiredVersion: bigint;
  readonly latestVersion: bigint;
  readonly acceptedVersion: bigint;
  /** True when trading is allowed for this account: nothing enforced, or accepted version >= required version. */
  readonly accepted: boolean;
  /** keccak256 of the exact required text, and where it is published; null while nothing is enforced. */
  readonly termsHash: Hex | null;
  readonly uri: string | null;
}

/** Unsigned `acceptTerms(version, termsHash)`. The account that sends it is the account that accepts. */
export function buildAcceptTerms(input: { chainId: number; termsRegistry: Address; version: bigint; termsHash: Hex }): Transaction {
  check(Number.isSafeInteger(input.chainId) && input.chainId > 0, "INVALID_CHAIN", "A positive chain ID is required");
  address(input.termsRegistry); hash(input.termsHash); uint(input.version);
  check(input.version < 1n << 64n, "INVALID_AMOUNT", "Terms version must fit uint64");
  return { chainId: input.chainId, to: input.termsRegistry, value: 0n, data: encodeFunctionData({
    abi: termsRegistryAbi, functionName: "acceptTerms", args: [input.version, input.termsHash],
  }) };
}

export function createTermsReader(context: ClientContext) {
  const { rpc, deployment, snapshot, assertCanonical, ensureVerified } = context;
  const registry = deployment.termsRegistry?.address ?? null;
  async function termsAt(account: Address, anchor: Anchor): Promise<TermsStatus> {
    address(account);
    if (!registry) {
      return Object.freeze({ ...anchor, account, termsRegistry: null, enforced: false, requiredVersion: 0n, latestVersion: 0n,
        acceptedVersion: 0n, accepted: true, termsHash: null, uri: null });
    }
    const at = { address: registry, abi: termsRegistryAbi, blockNumber: anchor.blockNumber } as const;
    const [requiredVersion, latestVersion, acceptedVersion, accepted] = await Promise.all([
      rpc.readContract({ ...at, functionName: "requiredVersion" }), rpc.readContract({ ...at, functionName: "latestVersion" }),
      rpc.readContract({ ...at, functionName: "acceptedVersion", args: [account] }),
      rpc.readContract({ ...at, functionName: "hasAccepted", args: [account] }),
    ]);
    // Mirrors the registry's own rule; any disagreement means an unexpected registry, so fail closed.
    check(requiredVersion <= latestVersion && accepted === (requiredVersion === 0n || acceptedVersion >= requiredVersion),
      "INVALID_TERMS_STATE", "Terms registry views are inconsistent");
    const published = requiredVersion > 0n
      ? await rpc.readContract({ ...at, functionName: "terms", args: [requiredVersion] }) : undefined;
    check(published === undefined || published.termsHash !== `0x${"0".repeat(64)}`, "INVALID_TERMS_STATE", "Required terms are not published");
    return Object.freeze({ ...anchor, account, termsRegistry: registry, enforced: requiredVersion > 0n, requiredVersion,
      latestVersion, acceptedVersion, accepted, termsHash: published?.termsHash ?? null, uri: published?.uri ?? null });
  }
  async function getTermsStatus(account: Address, blockNumber?: bigint): Promise<TermsStatus> {
    const anchor = await snapshot(blockNumber);
    await ensureVerified(anchor);
    const status = await termsAt(account, anchor);
    await assertCanonical(anchor);
    return status;
  }
  /**
   * Prepares the accept-terms transaction for `account`, or `transaction: null` when none is needed. The integrator must show
   * the user the text at `uri` and confirm its keccak256 equals `termsHash` before the user signs: accepting is the user's own act.
   */
  async function prepareAcceptTerms(input: { account: Address }) {
    const status = await getTermsStatus(input.account);
    if (!status.termsRegistry || status.accepted || !status.termsHash) return { ...status, transaction: null, simulated: false as const };
    const transaction = buildAcceptTerms({ chainId: deployment.chainId, termsRegistry: status.termsRegistry,
      version: status.requiredVersion, termsHash: status.termsHash });
    try { await rpc.call({ ...transaction, account: input.account, blockNumber: status.blockNumber }); }
    catch (cause) { throw new OxleyError("TERMS_ACCEPTANCE_REVERTED", "The terms registry rejected the acceptance", { cause: String(cause) }); }
    await assertCanonical(status);
    return { ...status, transaction, simulated: true as const };
  }
  return { termsAt, getTermsStatus, prepareAcceptTerms };
}
export type TermsReader = ReturnType<typeof createTermsReader>;
