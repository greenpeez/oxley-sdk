import { keccak256 } from "viem";
import { curveAbi, tokenAbi } from "./abis.js";
import { openingFeeCurveAbi } from "./gen3-abis.js";
import { check, sameAddress, uint } from "./validation.js";
import type { Anchor, Deployment, RpcClient } from "./types.js";

/** One verification cache per public client, reset after a failed verification. */
export function createClientContext(rpc: RpcClient, deployment: Deployment) {
  const startBlock = BigInt(deployment.startBlock);
  async function snapshot(blockNumber?: bigint): Promise<Anchor> {
    if (blockNumber !== undefined) uint(blockNumber, false);
    const [chainId, block] = await Promise.all([
      rpc.getChainId(), rpc.getBlock(blockNumber === undefined ? { blockTag: "latest" } : { blockNumber }),
    ]);
    check(chainId === deployment.chainId, "CHAIN_MISMATCH", "RPC chain does not match the deployment");
    check(block.number !== null && block.hash !== null && block.number >= startBlock,
      "INVALID_BLOCK", "A mined block after deployment is required");
    return { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp };
  }
  async function assertCanonical(anchor: Anchor): Promise<void> {
    const block = await rpc.getBlock({ blockNumber: anchor.blockNumber });
    check(block.hash === anchor.blockHash, "REORG", "Quote/discovery block changed; discard results and retry");
  }

  // Gen3/Gen8 curves enforce one immutable terms registry; the manifest pin must be that exact contract.
  async function verifyTermsBinding(anchor: Anchor): Promise<void> {
    if (!deployment.termsRegistry) return;
    const bound = await rpc.readContract({ address: deployment.curve.address, abi: openingFeeCurveAbi,
      functionName: "termsRegistry", blockNumber: anchor.blockNumber });
    check(sameAddress(bound, deployment.termsRegistry.address), "TERMS_BINDING_MISMATCH", "Curve terms registry does not match the manifest");
  }

  // Immutable deployments are checked at connection; callers can explicitly recheck at any time.
  let verified: Promise<void> | undefined;
  async function verifyAt(anchor: Anchor): Promise<void> {
    const pins = [deployment.curve, deployment.registry, deployment.quoteToken, ...deployment.termsRegistry ? [deployment.termsRegistry] : []];
    await Promise.all(pins.map(async pin => {
      const code = await rpc.getCode({ address: pin.address, blockNumber: anchor.blockNumber });
      check(code && code !== "0x" && keccak256(code).toLowerCase() === pin.runtimeCodeHash.toLowerCase(),
        "CODE_MISMATCH", `Runtime code differs at ${pin.address}`);
    }));
    const [quoteToken, decimals] = await Promise.all([
      rpc.readContract({ address: deployment.curve.address, abi: curveAbi, functionName: "quoteAsset", blockNumber: anchor.blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "decimals", blockNumber: anchor.blockNumber }),
    ]);
    check(sameAddress(quoteToken, deployment.quoteToken.address) && decimals === 6,
      "QUOTE_BINDING_MISMATCH", "Curve quote token or decimals do not match the manifest");
    await verifyTermsBinding(anchor);
    await assertCanonical(anchor);
  }
  async function ensureVerified(anchor: Anchor): Promise<void> {
    if (!verified) verified = verifyAt(anchor).catch(error => { verified = undefined; throw error; });
    await verified;
  }
  async function verifyDeployment() {
    const anchor = await snapshot();
    await verifyAt(anchor);
    verified = Promise.resolve();
    return { deployment, ...anchor };
  }

  return { rpc, deployment, startBlock, snapshot, assertCanonical, ensureVerified, verifyDeployment };
}
export type ClientContext = ReturnType<typeof createClientContext>;
