# Agent API: Swaps And The Bridge For Agents

`@oxley/sdk/agents` is a fetch-only client for the hosted Oxley Agent API. With it, an agent or bot can:

- swap on Elysium at the best of 0x's routes and Nest's pools;
- bridge between Elysium, Ethereum, Arbitrum, Base, BNB, HyperEVM, Robinhood Chain, and out to Solana;
- add its own integrator fee on top of Oxley's.

Every build comes back as **unsigned** transactions. The agent's own wallet signs and sends them. Oxley never holds a key or funds, and neither does the SDK.

Unlike the rest of this SDK, which is Gen10 testnet tooling, the Agent API runs on **mainnet**:

| | |
| --- | --- |
| Swap chain | Elysium, chain id `99901` (`AGENT_SWAP_CHAIN_ID`) |
| Quote and payment asset | USDC |
| API root | `https://oxley-agents.web3bandit.workers.dev` (`OXLEY_AGENT_API_URL`) |
| MCP server | `POST /mcp` |
| OpenAPI 3.1 file | `GET /v1/openapi.json` (no key needed) |

```ts
import { createOxleyAgentClient, requestAgentApiKey } from '@oxley/sdk/agents';
```

## Getting A Key

A key is issued to a wallet that signs one message (EIP-191 `personal_sign`):

```
Oxley API key
Address: <checksummed address>
Issued at: <ISO time, as toISOString writes it>
```

The rules:

- The time must be within 10 minutes of the server's clock.
- A wallet may hold at most 3 live keys.
- Only EOA signatures are accepted for now; contract-wallet signatures are not.
- The key (`oxk_…`) is shown once. Only its SHA-256 is stored.

```ts
import { privateKeyToAccount } from 'viem/accounts';

const { key } = await requestAgentApiKey({ signer: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`) });
const oxley = createOxleyAgentClient({ apiKey: key });
```

`signer` can be anything with `address` and `signMessage({ message })`. A viem local account already has both. For a wallet client, pass:

```ts
{ address, signMessage: ({ message }) => walletClient.signMessage({ account: address, message }) }
```

To sign elsewhere, use `prepareAgentKeyRequest(address)`, which returns `{ address, issuedAt, message }`. Sign `message`, then call `client.issueKey({ address, issuedAt, signature })`. `client.revokeKey()` revokes the client's own key.

## Tiers

Volume is the USD value of the transactions a key built that were confirmed on chain, counted over the last 30 days. A key moves up as soon as its volume reaches a tier's line. It keeps its highest tier for 30 days after reaching it.

| Tier | Unlocks at | Quotes/min | Builds/min | Quotes/day | Reads/min | Integrator fee cap |
| --- | --- | --- | --- | --- | --- | --- |
| Starter | a new key | 30 | 10 | 10,000 | 120 | 2% |
| Builder | $50,000 | 120 | 40 | 50,000 | 300 | 2% |
| Growth | $100,000 | 300 | 100 | 150,000 | 600 | 2% |
| Pro | $500,000 | 600 | 200 | 500,000 | 1,200 | 2% |
| Partner | by agreement | per key | | | | |

These are the current numbers, and they can change without an SDK release. `client.me()` returns the ones that apply to the key now: its tier, its limits, its 30-day volume and the next tier (`nextTier.remainingUsd`).

What each kind of call counts against:

- **Quotes:** `swapPrice` and `bridgeQuote`.
- **Builds:** `buildSwap` and `buildBridge`.
- **Reads:** everything else.

A call over a limit is refused with 429 and `retry-after`. So is a call that meets the API's shared ceiling on bridge calls (`BUSY`). Either way the server did nothing, so the client waits the time out and sends the call again. It does this once by default, and only when the wait is at most 10 seconds (`retries`, `maxRetryWaitMs`). Otherwise it throws `AgentApiError` with `retryAfterMs`.

## Swapping

| Call | Result |
| --- | --- |
| `swapTokens()` | Swap's listed tokens on Elysium, and whether Swap is `ready` |
| `swapPrice({ sellToken, buyToken, sellAmount, taker?, slippageBps?, integratorFee? })` | An indicative price after every fee: `buyAmount`, `minBuyAmount`, `sources`, `fee` and `partnerFee` |
| `buildSwap({ sellToken, buyToken, sellAmount, taker, slippageBps?, integratorFee? })` | `{ buildId, quote, steps }`. `quote.kind` is `pool` for Nest's pools, and the build expires at `quote.expiresAt` (Unix seconds) |
| `swapStatus({ hash, buildId? })` | `pending`, `success` or `reverted`. With `buildId` it also counts the swap (`report`) |

Amounts are decimal strings of base units: USDC has 6 decimals, so 10 USDC is `"10000000"`. Slippage is 10 to 500 basis points.

## Bridging

| Call | Result |
| --- | --- |
| `bridgeConfig()` | The chains, tokens and lanes the bridge serves, and whether each is available now |
| `bridgeQuote(intent)` | A quote for every hop (`legs`). Each hop's `quote.amountOut` is after every fee |
| `buildBridge({ ...intent, via })` | The first leg's `{ buildId, plan, prepared, steps }`. Pass `via` as `legs[0].quote.provider`, so the build uses the provider that quoted it |
| `bridgeStatus({ chainId, txHash, kind?, buildId? })` | The source transaction's state and the delivery's progress. Wait `retryAfterMs` between asks |

An intent is `{ account, recipient, sourceChainId, destinationChainId, tokenIn, tokenOut, amountIn, slippageBps?, gasTopUp?, integratorFee? }`. A transfer starts on an EVM chain. `recipient` is a Solana address when the destination is Solana. `gasTopUp` also delivers a little HYPE for gas on Elysium; it applies to USDC into Elysium only.

A transfer with more than one hop is built one hop at a time. Once the first hop lands, build the next hop with its own intent, which the answer carries.

## Sending A Build

1. Run `checkAgentSteps(steps, { account, chainId })` before signing. It checks that every step is a well-formed transaction from `account`, all on one chain, and that the last step is the build's own transaction. It does not prove that the calldata is safe. Before answering, the API checks pinned routers, exact approvals, recipients, minimums and value, the same checks the Oxley app runs.
2. Send the steps in order from the same wallet, waiting for each to confirm. `agentTransaction(step)` turns a step into a viem request (`walletClient.sendTransaction({ account, ...agentTransaction(step) })`).
3. Call `report({ buildId, txHash })` with the **last** step's hash.

The report counts the build's volume once the receipt matches the build. To match, the transaction must:

- have succeeded;
- be from the build's sender, to the build's contract;
- have landed within 24 hours of the build;
- not have been counted before.

What a report can return:

| `outcome` | Meaning |
| --- | --- |
| `counted` | Counted toward the key's 30-day volume |
| `pending` | The receipt is not readable yet; report again shortly |
| `failed` | The transaction did not succeed |
| `mismatch` | Not from the build's sender to the build's contract |
| `expired` | More than 24 hours after the build |
| `duplicate` | Already counted |

A build's USD value is its USDC side, or the token's market price when it has none. A build with no USD price counts zero.

## Integrator Fees

Pass `integratorFee: { recipient, bps }` to any price, quote or build call. `bps` is whole basis points, up to the key's tier cap (`me().limits.maxIntegratorFeeBps`).

The fee goes straight to `recipient`; Oxley never holds it. How it is taken depends on the route:

| Route | How the fee is taken |
| --- | --- |
| Swap through 0x | 0x takes it inside the swap (`partnerFee.method` is `0x`) |
| Swap through Nest's pools | A separate `Integrator fee` step, sent first. It transfers the fee's share of the input from the sender (`method` is `transfer`) |
| Every bridge leg | A separate `Integrator fee` step, sent first, on the source chain (`integratorFee` on the answer) |

Quoted amounts are after every fee. Oxley's own fee, when one is set, is shown in the answer's `fee`.

## MCP

Agents that use the Model Context Protocol can add the API as a server: Streamable HTTP at `POST /mcp` with the same key. `agentMcpServer(key)` returns the entry for an MCP client's settings:

```json
{ "mcpServers": { "oxley": { "type": "http", "url": "https://oxley-agents.web3bandit.workers.dev/mcp", "headers": { "Authorization": "Bearer oxk_your_key" } } } }
```

There are 10 tools:

- `get_tier`;
- `list_swap_tokens`, `get_swap_price`, `build_swap`, `get_swap_status`;
- `get_bridge_config`, `get_bridge_quote`, `build_bridge`, `get_bridge_status`;
- `report_transaction`.

Each tool is one of the API's own calls, with the same limits. The tools return unsigned transactions; the agent's wallet tool signs and sends them.

## Errors

Every refusal is an `AgentApiError` with `code`, `status`, `reason` and, on a 429, `retryAfterMs`.

| `code` | Cause |
| --- | --- |
| `INVALID_REQUEST` | Refused before sending (a bad address, amount, slippage, fee or hash) |
| `API_KEY_REQUIRED`, `API_KEY_INVALID` | No key, or one that is unknown or revoked |
| `INVALID_INTEGRATOR_FEE` | A fee over the tier's cap, or a malformed one |
| `RATE_LIMITED` | Over the key's per-minute or daily limit |
| `BUSY` | The API's shared bridge ceiling |
| `BAD_SIGNATURE` | The key message was not signed by the address |
| `TOO_MANY_KEYS` | The wallet already holds 3 live keys |
| `UNKNOWN_BUILD` | No build of this key has that id |
| `UNAVAILABLE` | Try again shortly |
| `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`, `INVALID_RESPONSE`, `HTTP_ERROR` | Raised by the client itself |

The swap and bridge providers' own refusals keep their codes, for example a route with no liquidity.

A timeout is never proof that nothing was sent. Before you build again, check the wallet for a transaction you already sent.

See [the example](../examples/agents.ts) for a complete swap: key, price, build, send and report.
