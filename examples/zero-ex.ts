import { buildZeroExBasic } from "@oxley/sdk/0x";
import type { Swap } from "@oxley/sdk";

export function sourceAction(quotedForExecutor: Swap) {
  // Quote for the real executor and this leg's input. BASIC patches the amount
  // from its token balance, so the provider must control that balance/percentage.
  // The provider supplies its normal funding and final recipient/slippage actions.
  return buildZeroExBasic(quotedForExecutor);
}
