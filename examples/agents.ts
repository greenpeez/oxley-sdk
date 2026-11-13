// An agent swaps 10 USDC for HYPE on Elysium through the Oxley Agent API, with its own wallet, then reports the swap so its volume counts toward the key's tier.
// It sends real transactions on Elysium mainnet: use a wallet you are willing to spend from. Run with OXLEY_API_KEY, AGENT_PRIVATE_KEY and ELYSIUM_RPC_URL set.
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AGENT_SWAP_CHAIN_ID, agentTransaction, checkAgentSteps, createOxleyAgentClient, requestAgentApiKey, type AgentStep } from '@oxley/sdk/agents';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex);
const elysium = defineChain({ id: AGENT_SWAP_CHAIN_ID, name: 'Elysium', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ELYSIUM_RPC_URL!] } } });
const publicClient = createPublicClient({ chain: elysium, transport: http() });
const wallet = createWalletClient({ account, chain: elysium, transport: http() });

/** Once per wallet: sign the key message and keep the key it returns (it is shown once). */
export async function newKey(): Promise<string> {
  const { key } = await requestAgentApiKey({ signer: account });
  return key;
}

/** Sends a build's steps in order from the agent's wallet, each confirmed before the next; returns the last (the build's own) transaction hash. */
async function send(steps: readonly AgentStep[]): Promise<Hex> {
  checkAgentSteps(steps, { account: account.address, chainId: AGENT_SWAP_CHAIN_ID });
  let last: Hex | undefined;
  for (const step of steps) {
    last = await wallet.sendTransaction({ account, ...agentTransaction(step) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: last });
    if (receipt.status !== 'success') throw new Error(`${step.label} reverted: ${last}`);
  }
  return last!;
}

export async function swapUsdcForHype(apiKey = process.env.OXLEY_API_KEY!) {
  const oxley = createOxleyAgentClient({ apiKey });
  const { tokens } = await oxley.swapTokens();
  const usdc = tokens.find(token => token.symbol === 'USDC')!, hype = tokens.find(token => token.symbol === 'HYPE')!;
  const sellAmount = parseUnits('10', usdc.decimals).toString();

  const price = await oxley.swapPrice({ sellToken: usdc.address, buyToken: hype.address, sellAmount, taker: account.address });
  if (!price.liquidityAvailable) throw new Error('No route for this swap right now.');

  // An integrator adds its own fee with integratorFee: { recipient, bps } (up to the tier's cap).
  const build = await oxley.buildSwap({ sellToken: usdc.address, buyToken: hype.address, sellAmount, taker: account.address, slippageBps: 50 });
  if (build.quote.expiresAt !== undefined && build.quote.expiresAt * 1000 < Date.now()) throw new Error('The build expired; build again.');
  const hash = await send(build.steps);

  // Counts the swap toward the key's 30-day volume; `pending` means the receipt is not readable yet.
  let { outcome } = await oxley.report({ buildId: build.buildId, txHash: hash });
  for (let tries = 0; outcome === 'pending' && tries < 5; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    ({ outcome } = await oxley.report({ buildId: build.buildId, txHash: hash }));
  }
  const standing = await oxley.me();
  return { hash, outcome, tier: standing.tier, volume30dUsd: standing.volume30dUsd, next: standing.nextTier };
}
