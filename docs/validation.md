# Validation Evidence

Updated 2026-10-16. This evidence covers the SDK and its selected integration
surface, not whole-repository acceptance or a new contract security audit.

## Current Evidence

- Current markets, terms, integrator fees and Gen8 Dynamic Bids (`0.6.0-next.1`, 2026-10-29): 122 unit/ABI
  tests, the 17 local EVM tests, typecheck, build and the clean-archive consumer check pass. New offline suites cover
  per-generation resolution, quotes and calldata against the full compiled ABIs, terms, the opening-surcharge mirror,
  fee batches (ordering, rounding, caps, tamper and staleness checks) and Dynamic Bids against a modelled hook and CCA.
  `npm run test:live:markets` (read-only, no signer) verified every pin of the flat-fee, Gen3 and Gen8 manifests, the
  Gen8 auction graph and the hook's compiled rules, resolved live flat-fee and Gen3 markets, quoted and prepared and
  checked fee-bearing buys and sells, read terms state (nothing enforced yet) and matched the surcharge mirror to both
  curves. No Gen8 market exists yet, so Dynamic Bid preparation has no live counterpart. Sources and hashes:
  [live-artifacts.json](live-artifacts.json). No funded transaction was sent.
- Gen2 support (`0.6.0-next.0`, 2026-10-20, offline only): 54 unit/ABI tests
  pass, including 14 Gen2 tests with mocked RPC fixtures; Gen2 ABIs are pinned by
  sha256 and source commit in [gen2-artifacts.json](gen2-artifacts.json). The Gen2
  manifest holds planned fork-rehearsal addresses, so no Gen2 testnet read, local
  EVM or funded check has been run against these SDK paths yet.
- [Auction launch validation](launch-validation.md): `0.5.0-next.4` adds unsigned
  launch preparation, creator-account ABIs and restart recovery. All 40 unit
  tests and 17 local EVM tests pass; read-only testnet checks verify launch pins,
  costs, gas-price cap and floor calculations. No remote funded launch was sent.
- [Funded testnet buy and sell](funded-swaps-2026-10-16.md): completed through
  the deployed application using the SDK's independent RPC quotes and locally
  computed 1% minimums. Successful receipts, exact outputs, historical balances,
  approvals and recovery were verified on 2026-10-16.
- [Auction SDK validation](auction-validation.md): real-bytecode local
  bid/refund/claim tests and read-only testnet graph/fee checks.
- [Indexed data validation](data-validation.md): public API checks across all
  eight resources, browser CORS and indexed-feed boundaries.
- The preceding `0.5.0-next.3` was a documentation-only release. Its runtime,
  ABIs, deployment profiles and dependencies remained those of `0.5.0-next.2`.

For that preceding documentation-only release on October 16: TypeScript checks passed, all 32 SDK
unit/ABI tests passed, the ESM/declaration build passed, and a clean consumer
installed the actual archive and verified imports, types and the file allowlist.
The public docs content/search suite passed all 17 tests. No new funded action
was required or submitted for this documentation update.

The funded trades do not prove funded auction participation, third-party wallet
extension compatibility, 0x hosted-route acceptance or mainnet readiness.

## Original Trading Checks (2026-10-13)

| Check | Result |
| --- | --- |
| TypeScript library, tests and examples | Pass |
| Scoped source, scripts, tests and examples lint | Pass |
| Unit/ABI/provenance tests | 14 passing |
| Local EVM suite | Six passing scenarios, plus suite wrapper (7 reported tests) |
| Standalone build | Pass; ESM JavaScript and declaration files emitted |
| Clean archive consumer | Imports, raw ABI JSON exports and TypeScript declarations pass |
| Distribution allowlist | Only runtime, ABI, docs, examples, deployment profiles and license |
| Public RPC deployment verification | Chain 99801 and all three contract pins match |

The public verification at block `8565674`, hash
`0xd90aa6df6d00a99a3b28ac5a5901d7e2392e67b01895caf4d5174c68d870b4d0`,
checked curve, registry and quote-token runtime hashes, the curve's actual quote
binding, and six-decimal token precision. This was read-only.

An optional quote check for historical pilot market
`0x71d75a89abd94f6e48e76b94da911ee67ac8a976525dd73908c0cd37661b2093`
was correctly refused as an unsupported/inactive market. It is not a valid live
swap example. That original run was read-only; quote and settlement parity were
demonstrated locally with the retained real curve bytecode. The October 16 funded
test above adds remote trade evidence without changing this historical result.

## Local Settlement Coverage

- Actual VNext curve, fee router, registry and listing-vault creation bytecode,
  with local six-decimal ERC-20 and market fixtures.
- Direct buy/sell: quote output equals actual recipient balance change.
- Generic routed buy: provider receives output, then pays its recipient; the
  Bought event records the executor as buyer.
- Split fills and token-to-USDC-to-another-token multihop, in one transaction.
- Failed final-route minimum: caller balances, curve position/capital, treasury,
  fee balances and reward state remain unchanged.
- Failed output transfer: atomic rollback. Failed treasury transfer: trade
  succeeds with the existing deferred treasury liability.
- Buy pause blocks buys while an allowed sell can still settle; expired and
  impossible-minimum swaps revert.

Illustrative gas in this fixture: direct buy `633478`, sell `220447`, and routed
BASIC buy `549230`. These use different preceding states and are not an overhead
comparison or a mainnet gas guarantee. SDK simulation estimated `685796` for
the tested direct buy. Always estimate the actual funded route.

Quote batches cache market validation within the selected block, avoiding
repeated registry/market/decimals reads for each sample of the same market.
For a warm single-market batch of 64 samples, the SDK performs 64 quote reads,
three shared market reads, one chain read and two block reads: 70 RPC method
calls, bounded to four samples in flight. Transport batching may reduce HTTP
requests. No remote latency or throughput guarantee is asserted.

## Reproduction And Boundaries

`test/fixtures/provenance.json` pins retained Oxley artifact and fixture hashes.
The source build was Solidity 0.8.26, Cancun, optimizer 200. SDK ABI selectors,
tuple layouts and events are checked against that build's full ABI.

The optional 0x helper was exercised against unmodified BASIC and utility source
at commit `0148a16f3f90ee09ac5f56c8da17f230f5fa5282`. Its isolated test executor
uses Solidity 0.8.34, Osaka and Anvil 1.7.1; it replaces upstream abstract context
with a fixture and ordinary funding/final settlement. Full 0x Permit2, signed
meta-transactions, deployment registry and Elysium chain-specific executor are
not covered. BASIC calldata compatibility is not hosted API source acceptance.

`npm run build:test-executor` rebuilds that fixture from the vendored source.
The public runtime has no Solidity compiler or test dependency. No protocol
contract, remote deployment, wallet policy, funded transaction or external source
configuration was changed during the original October 13 SDK validation.

The mainnet manifest is intentionally incomplete because mainnet chain/token/
deployment information is unavailable. Supply the reviewed values, verify the
graph, and run the provider's normal source-acceptance checks at launch. The
public npm registry was not updated by the October 13 validation run. Current
distribution status is tracked in the GitHub release notes.
