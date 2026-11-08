import { decodeErrorResult, type Address, type Hex } from "viem";
import { creatorAccountAbi } from "./launch-abis.js";
import { candidates, decodeOxleyRevert } from "./revert.js";
import { check, OxleyError } from "./validation.js";
import type { LaunchRpcClient } from "./launch-types.js";

/** What the creator account's generic `InvalidConfiguration()` means for each step that can hit it (the account uses one error for every refusal). */
const ACCOUNT_REFUSAL: Readonly<Record<string, string>> = {
  schedule: "the account is unlaunched and unscheduled, the name at most 80 bytes, the bond exactly 0.5 HYPE and the start 15 minutes to 8 days after the chain's latest block",
  execute: "the launch must be due, inside its 24 hour window as of the chain's latest block, and not launched yet",
  refund: "the 24 hour window must have closed as of the chain's latest block, without a launch",
  "claim-fee": "no refunded launch fee is owed",
  "claim-bond": "the recipient must be neither empty nor the account itself",
  "claim-fees": "the recipient must be a nonzero address other than the account",
};
const ACCOUNT_ERRORS = ["InvalidConfiguration", "Unauthorized", "TransferAmountMismatch", "ScheduledLaunchSimulated"];
function accountRevert(cause: unknown) {
  for (const data of candidates(cause, [])) {
    try { const { errorName, args } = decodeErrorResult({ abi: creatorAccountAbi, data }); if (ACCOUNT_ERRORS.includes(errorName)) return { name: errorName, args: args ?? [] }; } catch { /* Not the account's error. */ }
  }
  return null;
}
/** A failed read-only call, with the Oxley rule it hit when the revert decodes. The RPC URL a client error may carry is never passed on. */
export function stepFailure(stage: string, what: "simulation" | "gas estimate", cause: unknown, symbol: string): never {
  const revert = decodeOxleyRevert(cause, { quoteSymbol: symbol }), account = revert ? null : accountRevert(cause);
  const reason = String((cause as { shortMessage?: string })?.shortMessage ?? (cause as Error)?.message ?? cause).split("\n")[0]!.replace(/https?:\/\/\S+/g, "<rpc>");
  const message = revert ? revert.message : account ? `the account reverted with ${account.name}${account.name === "InvalidConfiguration" && ACCOUNT_REFUSAL[stage] ? ` (${ACCOUNT_REFUSAL[stage]})` : ""}` : reason;
  throw new OxleyError("SIMULATION_FAILED", `The ${stage} step failed in ${what}: ${message}`,
    { stage, revert: revert ? { name: revert.name, args: revert.args, message: revert.message } : null, accountRevert: account, reason });
}
/** The sending wallet's native balance, pending nonce and the chain's gas price, refused when a transaction of the wallet is still pending. */
export async function readWallet(rpc: LaunchRpcClient, account: Address, blockNumber: bigint) {
  const [native, pending, confirmed, gasPrice] = await Promise.all([rpc.getBalance({ address: account, blockNumber }),
    rpc.getTransactionCount({ address: account, blockTag: "pending" }), rpc.getTransactionCount({ address: account, blockTag: "latest" }), rpc.getGasPrice()]);
  check(pending === confirmed, "PENDING_TRANSACTION", "Resolve the wallet's pending transaction before preparing again");
  check(gasPrice > 0n, "INVALID_GAS_PRICE", "The RPC must return a positive gas price");
  return { native, nonce: pending, gasPrice };
}
/** A pending nonce that moved while a step was prepared invalidates it. */
export async function checkNonce(rpc: LaunchRpcClient, account: Address, nonce: number) {
  check(await rpc.getTransactionCount({ address: account, blockTag: "pending" }) === nonce, "NONCE_CHANGED", "Wallet activity changed during preparation; prepare again");
}
export interface StepRequest { to: Address; data: Hex; value: bigint; account: Address; blockNumber: bigint; gasPrice?: bigint; gas?: bigint }
/** Simulates the step from its sender at the observation block and estimates its gas; both are failures of the step (`SIMULATION_FAILED`). */
export async function simulateStep(rpc: LaunchRpcClient, stage: string, request: StepRequest, symbol: string) {
  let simulation;
  try { simulation = await rpc.call(request); } catch (cause) { stepFailure(stage, "simulation", cause, symbol); }
  let gasEstimate;
  try { gasEstimate = await rpc.estimateGas(request); } catch (cause) { stepFailure(stage, "gas estimate", cause, symbol); }
  return { data: simulation.data, gasEstimate };
}
