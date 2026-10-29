import { parseAuctionDeployment } from "./auctions.js";
import { address, check, deploymentGeneration, hash, uint } from "./validation.js";
import type { LaunchDeployment } from "./launch-types.js";

const BOND = 500_000_000_000_000_000n;
export function parseLaunchDeployment(input: unknown): LaunchDeployment {
  const base = parseAuctionDeployment(input), pins = (input as LaunchDeployment).launchBindings;
  check(deploymentGeneration(base) !== "gen8", "UNSUPPORTED_GENERATION", "Gen8 launches use their own creator account and are not prepared by this module");
  check(pins && typeof pins === "object", "LAUNCH_BINDINGS_REQUIRED", "Reviewed launch bindings are required");
  for (const p of [pins.creatorAccountFactory, pins.entryController, pins.bondEscrow]) {
    check(p && typeof p === "object", "LAUNCH_BINDINGS_REQUIRED", "Missing launch contract pin");
    address(p.address); hash(p.runtimeCodeHash);
  }
  for (const amount of [pins.launchFeeBaseUnits, pins.deployerBondWei]) {
    check(typeof amount === "string" && /^[1-9][0-9]*$/.test(amount), "INVALID_LAUNCH_COST", "Explicit positive base-unit launch costs required");
    uint(BigInt(amount));
  }
  check(BigInt(pins.deployerBondWei) === BOND, "INVALID_BOND", "This controller requires the creator's 0.5 native-asset operating bond");
  const addresses = [base.curve.address, base.registry.address, base.quoteToken.address, base.auctionController,
    base.auctionBindings.bidRouter.address, base.auctionBindings.adapter.address,
    pins.creatorAccountFactory.address, pins.entryController.address, pins.bondEscrow.address];
  check(new Set(addresses.map(a => a.toLowerCase())).size === addresses.length, "INVALID_DEPLOYMENT", "Launch contracts must be distinct");
  return Object.freeze({ ...base, launchBindings: Object.freeze({ ...pins,
    creatorAccountFactory: Object.freeze({ ...pins.creatorAccountFactory }),
    entryController: Object.freeze({ ...pins.entryController }), bondEscrow: Object.freeze({ ...pins.bondEscrow }) }) });
}
