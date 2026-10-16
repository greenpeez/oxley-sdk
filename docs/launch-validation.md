# Auction Launch Validation

Validated 2026-10-16 for `@oxley/sdk@0.5.0-next.4`. This is SDK integration
evidence, not a new protocol security audit or a funded remote launch.

## Coverage

- 40 unit/ABI tests pass across trading, indexed data, auction participation and
  launch helpers. Launch cases cover exact calldata/value, integer/price units,
  unsupported terms, missing or conflicting pins, account ownership, changed
  fees/bonds, stale/reorganized observations, insufficient funds, pending/changed
  nonces, false approvals, simulation failures and the launch gas-price cap.
- 17 reported local EVM tests pass (14 scenarios plus three suite wrappers),
  including existing swaps, upstream BASIC compatibility, bids, refunds and
  claims. Four new launch scenarios execute the retained auction graph's actual
  bytecode, not a mock launch controller.
- Launch execution verifies factory account identity; recovery with a fresh SDK
  client after setup and approvals; zero-first and exact fee approvals; rejection
  of another caller and excessive gas price; exact 1.5 Oxy-USDC fee debit and
  0.5 native-unit bond plus receipt gas debit; original bond beneficiary; emitted
  name, symbol and listing commitment; installed auction currency, floor and
  tick spacing; completed-launch recovery; replay and duplicate ticker rejection;
  and paused-launch rejection without losing completed-launch lookup.
- The prepared gas estimate was `8669433`; execution used `8286374`. These are
  observations for this local fixture, not mainnet cost guarantees.
- TypeScript checks and the ESM/declaration build pass. A clean consumer installs
  the actual npm archive and verifies module imports, ABI JSON, declarations and
  the distribution file allowlist. Public docs pass all 17 content/search tests
  and a production build.

## Read-Only Testnet Verification

At Elysium testnet block `10247568`, hash
`0xba99df8bde471246a292a731a1951bd47dde6001eccaed0c6075e3cb7eaf7818`:

- Chain ID `99801`; existing auction pins and new factory, entry and bond pins
  match on-chain runtimes and their bindings.
- Launch fee `1500000` Oxy-USDC base units; operating bond
  `500000000000000000` native base units; launch gas-price cap `1000000000` wei.
- Public launches enabled; entries not paused.
- Three locally calculated floor/tick samples match the deployed adapter.

`npm run test:live:launch` reproduces these read-only checks using a paced public
RPC transport, or `OXLEY_RPC_URL` for a provider chosen by the integrator. State
and availability can change after this observation.

## Reproduction And Limits

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run test:package`, and
`ANVIL_BIN=/path/to/anvil npm run test:evm` from a source checkout.
The launch suite starts its own **unforked localhost node**. Its chain ID is
99801 because the retained testnet fee router enforces that ID; it does not
connect to the remote network. It uses Anvil 1.7.1, fake local funds, fixture
ERC-20/price contracts, Permit2 runtime and an ArbSys block-number stub. Production
network timing, RPC transport availability and wallet UX are not reproduced.

[Artifact evidence](launch-artifacts.json) records the retained compiler artifact,
full ABI and local fixture hashes, including the authorized deployment recipe.
Published ABI subsets are checked against compiler ABIs. Local fixtures and the
Solidity compiler are not included in the npm archive.

No remote funded launch, mainnet deployment, editable-metadata publication,
wallet custody or unattended agent spending policy is claimed. Mainnet still
requires the reviewed USDC-bound graph and manifest.
