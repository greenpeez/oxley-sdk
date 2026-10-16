# Auction Launches

Available in `@oxley/sdk@0.5.0-next.4` through `@oxley/sdk/launch`. Builders and
AI agents can prepare launches directly from an independently configured RPC.
No Oxley backend, API key, private signer or provider-specific integration is
required. The SDK never signs or broadcasts. The caller must have authority to
use the creator's wallet and must retain its transaction journal.

## Connect And Prepare

```ts
import { createPublicClient, http, parseUnits } from 'viem';
import { createOxleyLaunchClient } from '@oxley/sdk/launch';
import deployment from '@oxley/sdk/deployments/elysium-testnet.json'
  with { type: 'json' };

const launches = createOxleyLaunchClient({
  deployment,
  publicClient: createPublicClient({ transport: http('https://testnet-rpc.elysium.kinetiq.xyz') }),
});
// Generate a nonzero random bytes32 dealId ONCE and persist it with these terms.
// Reuse the same owner, dealId and terms after reloads, timeouts and retries.
const intent = {
  owner: '0xYOUR_AUTHORIZED_CREATOR_WALLET',
  dealId: '0xYOUR_PERSISTED_32_BYTE_ID',
  name: 'Example Coin',
  symbol: 'EXAMPLE',
  floorPriceWad: parseUnits('0.00001', 24),
  creatorLockDays: 30,
  listingCommitmentBps: 5000,
  auctionDurationHours: 1,
} as const;

const step = await launches.prepareLaunch(intent);
if (step.stage === 'complete') {
  console.log(step.creatorAccount, step.coin, step.auction);
} else {
  // Review stage, transaction, costs and expiry. Check wallet chain and owner.
  // Persist a pending intent BEFORE wallet submission; persist its hash immediately.
  // Sign/send step.transaction with your wallet. Confirm a successful canonical
  // receipt, then prepareLaunch(intent) again. Never blindly replay on timeout.
  console.log(step.stage, step.transaction, step.launchFee, step.deployerBondWei);
}
```

See the typechecked [example](../examples/launch.ts). The public RPC is
rate-limited: production callers should use their own RPC capacity and transport
pacing. Do not treat an RPC error as permission to fall back to unverified calldata.

## Stages And Recovery

| Stage | Unsigned transaction | Native value |
| --- | --- | --- |
| `setup` | Factory `createAccount(dealId, owner)` | `0` |
| `reset` | Quote token `approve(creatorAccount, 0)` when allowance is nonzero but insufficient | `0` |
| `approve` | Quote token `approve(creatorAccount, exactLaunchFee)` | `0` |
| `launch` | Creator account `launchAuctionWithCommitmentAndDuration(...)` | Exact operating bond |
| `complete` | None; returns existing creator account, coin and auction | No transaction |

The fee spender and launch target are the **creator account**, not the controller
or bid router. Setup records the wallet as controller and fee beneficiary; the
original wallet remains the bond beneficiary. Each call resolves confirmed state
again, so a confirmed setup or approval is not repeated. An already-launched
identity returns `complete`, even if launches have since been paused or funds
spent. It reports the existing launch; it does not apply newly supplied terms.
`getLaunch({owner,dealId})` also checks status without needing the original terms.

Persist `(chainId, releaseId, owner, dealId, terms, stage, transaction hash)`.
After an ambiguous wallet response, reconcile receipts, wallet nonce and
`getLaunch` before retrying. A missing receipt is not proof that no transaction
was sent. Pending wallet transactions block new preparation. The SDK is not a
durable broadcaster, nonce coordinator or automatic retry service.

## Terms, Units And Costs

- Name: trimmed, 1-80 UTF-8 bytes. Symbol: 1-10 uppercase ASCII letters/digits.
- Creator lock: `0`, `30` or `60` days. Listing commitment: `5000` or `10000` bps.
- Duration: `1` through `24` whole hours.
- **Floor scale:** despite the contract's `floorPriceWad` name, the deployed
  six-decimal quote / eighteen-decimal coin adapter uses **24 decimal places for
  a human USDC-per-coin price**. For example, `parseUnits('0.00001', 24)` is
  `10000000000000000000n`, not an eighteen-decimal conversion. The current minimum
  input is `9959120000000000000n`; upper bounds and upward tick rounding are
  enforced by `quoteAuctionFloor`. Review its effective price, not just the input.
- Current testnet launch fee: **1.5 Oxy-USDC**, `1500000n` base units. This is
  separate from bids and trading fees.
- Current creator-funded operating bond: **0.5 HYPE**, `500000000000000000n`
  native units, plus gas. It funds existing delivery/refund operations. Unused
  bond returns follow the existing escrow/account rules and remain owned by the
  original creator wallet. The helper does not withdraw it or guarantee a full
  refund. HYPE is not an alternative bid/trade payment asset.

The manifest explicitly pins fee and bond expectations, verified against chain.
Preparation checks quote balance, native bond and gas for the next step; it does
not promise a total lifecycle gas budget. `gasEstimate` and the 20%-buffered
`estimatedGasCost` are estimates, not gas guarantees or signed spending caps.
Prepared transactions include the same `gasPrice` used in simulation and gas
estimation. The launch step also checks the escrow's `MAX_GAS_PRICE` (currently
1 gwei). Preserve that field when sending; do not replace it with wallet-default
fee settings. If network fees exceed the cap, wait and re-prepare. The offline
encoders do not supply gas pricing.

## Verification And Boundaries

Every preparation verifies auction runtime pins and bindings plus the creator
factory, entry controller and bond escrow. It verifies account registration,
owner, beneficiary, immutable deal identity and quote/bond bindings; checks public
launch/pause state, ticker and deal availability; independently recomputes and
checks the adapter floor; simulates the exact next call and estimates gas.
Reorganized, stale, wrong-chain, changed-cost or changed-nonce observations fail
closed. `maxBlockAgeSeconds` defaults to 120 and must be 1-300 seconds.

`expiresAt` is a **client validity limit**, not an on-chain deadline: the existing
launch method has no deadline argument. Re-prepare before signing, and discard
expired preparations. State can change after simulation; propagate reverts and
never silently change the launch terms. Use normal receipt finality checks.

`buildCreatorAccount` and `buildAuctionLaunch` are offline encoders. They validate
shape/terms but do not authenticate an arbitrary account or manifest, check state
or simulate. Prefer `createOxleyLaunchClient` for actual launches. Full compiler
ABIs are exported at `@oxley/sdk/abis/creator-account-factory.json` and
`@oxley/sdk/abis/creator-account.json`; typed subsets are in `/launch` and `/abis`.
The full historical ABI includes other methods; their presence is not SDK
support for reserve/mint launches or administrative operations.

On-chain name/symbol are included. Off-chain editable metadata (images,
descriptions, websites and social links), uploads and metadata signatures are
**not** published by these helpers. They remain a separate authorized workflow.
The SDK adds no wallet custody, sponsorship or unattended spending policy.

The included profile is Elysium **testnet only**, chain `99801`. Mainnet requires
the reviewed USDC-bound graph and populated `launchBindings`; see
[mainnet inputs](mainnet.md). No mainnet addresses are guessed.
