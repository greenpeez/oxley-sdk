# Changelog

## 0.5.0-next.0 - 2026-10-14

Initial standalone Elysium integration release for aggregators and exchanges.

- Active auction-market discovery and block-pinned on-chain quotes.
- Unsigned buy/sell calldata, exact approvals and optional funded simulation.
- Optional 0x BASIC action encoding without a provider-specific callback.
- Full contract ABIs, Solidity interface, testnet runtime pins and mainnet template.
- Reproducible unit, ABI, package-consumer and local EVM settlement tests.

This release uses the `next` channel. It does not replace the legacy `0.4.1`
`latest` release or preserve that release's `/release` and `/evm` API.
Mainnet deployment details and provider route acceptance remain external launch
requirements. Routed buying rewards identify the immediate executor, not its end user.
