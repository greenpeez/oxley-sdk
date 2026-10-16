# Funded Testnet Buy And Sell

Verified at **2026-10-16 17:11:24 UTC**, Elysium testnet, chain **99801**.
This is an application integration test using `@oxley/sdk@0.5.0-next.2`, not a
mainnet test or a claim that 0x has enabled the source. The documentation-only
`0.5.0-next.3` release retains the same SDK runtime.

The real deployed application performed a desktop buy and a mobile sell using a
bounded EIP-6963 test-wallet provider. Signing occurred in the local runner; this
does not claim coverage of a particular third-party wallet extension. Browser
quotes used the independent RPC; the runner rejected backend trade-quote requests.

## Market And Wallet

| Field | Value |
| --- | --- |
| Market | MAYHEM |
| Market ID | `0x3894ebc64e1cedce1561ff29af4cbe5cce404e63b309be08273105b9127bb323` |
| Token, 18 decimals | `0x7286AAc55Cc494554c285374635A61979086aF00` |
| Oxy-USDC, 6 decimals | `0xa4ce6e6c719f7fb524230c367948039b078683e4` |
| Curve | `0x18bf92514c0d749a017aaf69153442703e1a966b` |
| Isolated test wallet | `0xc641989f58ff60059f88Bf010D39CF65d38704eb` |

## Confirmed Transactions

| Action | Transaction | Block | Amount / result |
| --- | --- | --- | --- |
| Exact Oxy-USDC approval | [0x0784a4a6](https://elysium.kinetiq.xyz/testnet-explorer/transaction/0x0784a4a69dd7465316d4017f971c9f9b0eb3339180675cedef4af0acb10b48fa) | 10169451 | 10 Oxy-USDC |
| Buy | [0xfa766fba](https://elysium.kinetiq.xyz/testnet-explorer/transaction/0xfa766fbacbb2a7fc08f2add50d382ea89ff6cf940579ee8a30e11a61516de9e6) | 10170787 | 10 Oxy-USDC -> 35,527.69309473448604253 MAYHEM |
| Exact MAYHEM approval | [0x8f171d52](https://elysium.kinetiq.xyz/testnet-explorer/transaction/0x8f171d5217f39de7cb7718443d19ac6353b02445303a81e948f1a3b2d0f31b97) | 10175873 | Only the purchased MAYHEM |
| Sell | [0x154f0640](https://elysium.kinetiq.xyz/testnet-explorer/transaction/0x154f0640c870c160049922b7e17dc87b441243852d95180c809a371cdb742810) | 10175993 | All purchased MAYHEM -> 9.607494 Oxy-USDC |

## Slippage And Balance Verification

Both signed minimums exactly matched
`floor(independently observed RPC output * 9900 / 10000)` in integer base units.

| Trade | Signed minimum | Actual output | Fee |
| --- | --- | --- | --- |
| Buy | 35,172.416163787141182104 MAYHEM | 35,527.69309473448604253 MAYHEM | 0.2 Oxy-USDC |
| Sell | 9.511419 Oxy-USDC | 9.607494 Oxy-USDC | 0.196071 Oxy-USDC |

Receipts, sender, destination, chain, nonce, calldata, canonical block hashes and
exact Bought/Sold events were independently re-read. Historical balances at
blocks 10169450, 10170787 and 10175993 reconciled against outputs and gas costs.
The sell returned zero native collateral.

| Balance | Before | After both trades |
| --- | --- | --- |
| Oxy-USDC | 10,000 | 9,999.607494 |
| MAYHEM | 0 | 0 |
| Testnet HYPE (gas only) | 0.004 | 0.003904431637605 |

Both allowances finished at zero. Latest and pending nonces were both 4; no
transaction remained pending at verification time. Total gas for the four
transactions was 0.000095568362395 testnet HYPE. Net Oxy-USDC cost was 0.392506;
this reflects fees and intervening market movement, not fees alone.

## Recovery And Limitations

- Reload after each confirmed approval exercised recovery and required a fresh
  user action/quote before trading. No unlimited approvals were used.
- An initial RPC throttle stopped before buy signing. A later signed buy was
  rejected when its sampled gas price fell below the next base fee. Recovery
  resent only the identical signed bytes/hash, not a replacement or duplicate buy.
- The app retained its unknown-outcome hold until chain finality enabled
  automatic discovery. No application storage or pending journal was cleared
  manually to bypass recovery.
- These results do not cover funded bid/claim/refund transactions, the full 0x
  settlement stack, exchange custody, load/latency guarantees or mainnet USDC.
  See [auction tests](auction-validation.md), [0x boundaries](0x.md) and
  [mainnet inputs](mainnet.md) for those distinct integration requirements.

Transaction links are public evidence. Wallet credentials, raw signed payloads
and browser authentication state are not included or required to inspect it.
