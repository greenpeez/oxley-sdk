import { parseAbi } from "viem";

/**
 * Gen3 typed integration subsets. Full compiler ABIs are exported under `@oxley/sdk/abis/gen3/curve.json` and
 * `@oxley/sdk/abis/terms-registry.json`. The flat-fee `curveAbi` entries the SDK reads (`market`, `quoteBuy`, `quoteSell`,
 * `buy`, `sell`) are unchanged in the Gen3 curve; these add only the Gen3 entries. Gen8 curves expose the same views.
 */
export const termsRegistryAbi = parseAbi([
  "function latestVersion() view returns (uint64)",
  "function requiredVersion() view returns (uint64)",
  "function acceptedVersion(address user) view returns (uint64)",
  "function hasAccepted(address user) view returns (bool)",
  "function terms(uint64 version) view returns ((bytes32 termsHash,uint64 publishedAt,string uri))",
  "function acceptTerms(uint64 version,bytes32 termsHash)",
  "event TermsAccepted(address indexed user,uint64 indexed version,bytes32 termsHash,address indexed submitter)",
  "error TermsNotAccepted(address user,uint64 requiredVersion,uint64 acceptedVersion)",
  "error UnknownVersion(uint64 version)",
  "error TermsHashMismatch(uint64 version,bytes32 expected,bytes32 provided)",
  "error AlreadyAccepted(address user,uint64 acceptedVersion)",
]);
/** Views shared by the Gen3 and Gen8 curves: the bound terms registry and the decaying opening surcharge. */
export const openingFeeCurveAbi = parseAbi([
  "function termsRegistry() view returns (address)",
  "function openingSurchargeWad(bytes32 dealId) view returns (uint256)",
  "function currentBuyFeeBps(bytes32 dealId) view returns (uint256)",
  "function surchargeWadAt(uint256 elapsed) pure returns (uint256)",
  "function STANDARD_TRADING_FEE_BPS() view returns (uint256)",
  "function MINIMUM_BUY_USDC_UNITS() view returns (uint256)",
  "error TradingNotOpen(bytes32 dealId,uint256 fallbackOpensAt)",
  "error BuysPaused()",
  "error MinimumNotMet()",
  "error DeadlineExpired()",
]);
