# Validation Evidence

Recorded 2026-10-13. This evidence covers the SDK and its selected integration
surface, not whole-repository acceptance or a new contract security audit.

## Completed Checks

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
swap example. No successful current live-market quote or funded remote swap is
claimed by this evidence; quote and settlement parity were demonstrated locally
with the retained real curve bytecode.

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
configuration was changed during this SDK build.

The mainnet manifest is intentionally incomplete because mainnet chain/token/
deployment information is unavailable. Supply the reviewed values, verify the
graph, and run the provider's normal source-acceptance checks at launch. The
public npm registry was not updated by the October 13 validation run. Current
distribution status is tracked in the GitHub release notes.
