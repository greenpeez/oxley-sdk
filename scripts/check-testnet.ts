import { readFile } from "node:fs/promises";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { createOxleyClient } from "../src/index.js";

const deployment = JSON.parse(await readFile(new URL("../deployments/elysium-testnet.json", import.meta.url), "utf8"));
const publicClient = createPublicClient({ transport: http(process.env.OXLEY_RPC_URL ?? "https://testnet-rpc.elysium.kinetiq.xyz",
  { timeout: 15_000, retryCount: 1 }) });
const sdk = createOxleyClient({ publicClient, deployment });
const verified = await sdk.verifyDeployment();
console.log(JSON.stringify({ chainId: deployment.chainId, releaseId: deployment.releaseId,
  blockNumber: verified.blockNumber.toString(), blockHash: verified.blockHash, runtimePinsMatch: true }));
if (process.env.OXLEY_MARKET_ID && process.env.OXLEY_CALLER) {
  const marketId = process.env.OXLEY_MARKET_ID as Hex;
  const { market } = await sdk.getMarket(marketId);
  const quote = await sdk.quote({ marketId, tokenIn: market.quoteToken, tokenOut: market.coin,
    amountIn: 1_000_000n, caller: process.env.OXLEY_CALLER as Address });
  console.log(JSON.stringify(quote, (_, value) => typeof value === "bigint" ? value.toString() : value));
}
