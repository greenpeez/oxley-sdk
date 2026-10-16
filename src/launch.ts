import { encodeFunctionData, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { createOxleyAuctionClient, parseAuctionDeployment, type AuctionDeployment } from "./auctions.js";
import { registryAbi, tokenAbi } from "./abis.js";
import { creatorAccountAbi, creatorAccountFactoryAbi, launchControllerAbi, launchEntryAbi,
  launchBondAbi, launchFloorAbi } from "./launch-abis.js";
import { address, check, hash, sameAddress, uint } from "./validation.js";
import type { Anchor, ContractPin, RpcClient, Transaction } from "./types.js";
export * from "./launch-abis.js";

export type LaunchRpcClient = RpcClient & Pick<PublicClient, "getBalance" | "getTransactionCount" | "getGasPrice">;
export interface LaunchDeployment extends AuctionDeployment {
  launchBindings: {
    creatorAccountFactory: ContractPin;
    entryController: ContractPin;
    bondEscrow: ContractPin;
    launchFeeBaseUnits: string;
    deployerBondWei: string;
  };
}
export interface AuctionLaunchInput {
  /** Stable, nonzero identity. Persist it before any transaction and reuse on retry. */
  dealId: Hex;
  owner: Address;
  name: string;
  symbol: string;
  /** Deployed adapter's price scale, not parseUnits(price, 18). See quoteAuctionFloor. */
  floorPriceWad: bigint;
  creatorLockDays: 0 | 30 | 60;
  listingCommitmentBps: 5000 | 10000;
  auctionDurationHours: number;
}
/** Only launch carries native value; swaps and bids retain Transaction.value = 0n. */
export interface AuctionLaunchTransaction extends Omit<Transaction, "value"> { readonly value: bigint; readonly gasPrice?: bigint }
const BOND = 500_000_000_000_000_000n;
const Q96 = 1n << 96n, DENOMINATOR = 10n ** 36n;
const MAX_PRICE = 50_505_050_505n * Q96 / (4n * 10n ** 18n);
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** Mirrors the current adapter, including upward tick rounding and the vendor CCA ceiling. */
export function quoteAuctionFloor(floorPriceWad: bigint) {
  uint(floorPriceWad);
  check(floorPriceWad >= 9_959_120_000_000_000_000n, "INVALID_FLOOR", "Floor is below the supported minimum");
  const raw = ceil(floorPriceWad * Q96, DENOMINATOR);
  const spacing = ceil(raw, 10_000n), tickSpacingQ96 = spacing < 2n ? 2n : spacing;
  const floorPriceQ96 = ceil(raw, tickSpacingQ96) * tickSpacingQ96;
  check(raw >= (1n << 32n) + 1n && tickSpacingQ96 < MAX_PRICE
    && floorPriceQ96 <= MAX_PRICE - tickSpacingQ96, "INVALID_FLOOR", "Floor exceeds supported CCA bounds");
  return { floorPriceQ96, tickSpacingQ96, effectiveFloorPriceWad: ceil(floorPriceQ96 * DENOMINATOR, Q96) };
}
export function validateAuctionLaunch(input: AuctionLaunchInput): void {
  check(!!input && typeof input === "object", "INVALID_LAUNCH", "Launch input required");
  hash(input.dealId); address(input.owner);
  check(typeof input.name === "string" && input.name.trim() === input.name && input.name.length > 0
    && new TextEncoder().encode(input.name).length <= 80, "INVALID_NAME", "Name must be trimmed and 1-80 UTF-8 bytes");
  check(typeof input.symbol === "string" && /^[A-Z0-9]{1,10}$/.test(input.symbol),
    "INVALID_SYMBOL", "Symbol must contain 1-10 uppercase ASCII letters or digits");
  check([0, 30, 60].includes(input.creatorLockDays), "INVALID_LOCK", "Creator lock must be 0, 30 or 60 days");
  check([5000, 10000].includes(input.listingCommitmentBps), "INVALID_COMMITMENT", "Listing commitment must be 50% or 100%");
  check(Number.isInteger(input.auctionDurationHours) && input.auctionDurationHours >= 1 && input.auctionDurationHours <= 24,
    "INVALID_DURATION", "Auction duration must be 1-24 whole hours");
  quoteAuctionFloor(input.floorPriceWad);
}
export function parseLaunchDeployment(input: unknown): LaunchDeployment {
  const base = parseAuctionDeployment(input), pins = (input as LaunchDeployment).launchBindings;
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
export function buildCreatorAccount(input: { deployment: unknown; owner: Address; dealId: Hex }): Transaction {
  const d = parseLaunchDeployment(input.deployment); address(input.owner); hash(input.dealId);
  return { chainId: d.chainId, to: d.launchBindings.creatorAccountFactory.address, value: 0n,
    data: encodeFunctionData({ abi: creatorAccountFactoryAbi, functionName: "createAccount", args: [input.dealId, input.owner] }) };
}
export function buildAuctionLaunch(input: AuctionLaunchInput & { deployment: unknown; creatorAccount: Address }): AuctionLaunchTransaction {
  const d = parseLaunchDeployment(input.deployment); validateAuctionLaunch(input); address(input.creatorAccount);
  return { chainId: d.chainId, to: input.creatorAccount, value: BigInt(d.launchBindings.deployerBondWei),
    data: encodeFunctionData({ abi: creatorAccountAbi, functionName: "launchAuctionWithCommitmentAndDuration",
      args: [input.name, input.symbol, input.floorPriceWad, input.creatorLockDays, input.listingCommitmentBps, input.auctionDurationHours] }) };
}

/** Unsigned, one-step preparation. Confirm each receipt, then call again with the same intent. */
export function createOxleyLaunchClient(options: { publicClient: LaunchRpcClient; deployment: unknown; maxBlockAgeSeconds?: number }) {
  const rpc = options.publicClient, deployment = parseLaunchDeployment(options.deployment);
  const auctions = createOxleyAuctionClient({ publicClient: rpc, deployment });
  const pins = deployment.launchBindings, factory = pins.creatorAccountFactory.address, controller = deployment.auctionController;
  const maxAge = options.maxBlockAgeSeconds ?? 120;
  check(Number.isInteger(maxAge) && maxAge > 0 && maxAge <= 300, "INVALID_BLOCK_AGE", "Block age limit must be 1-300 seconds");
  const now = () => BigInt(Math.floor(Date.now() / 1000));
  function fresh(at: Anchor) {
    check(at.timestamp >= now() - BigInt(maxAge) && at.timestamp <= now() + 5n,
      "STALE_BLOCK", "RPC observation is stale; prepare again using a current RPC");
  }
  async function canonical(at: Anchor) {
    fresh(at);
    check((await rpc.getBlock({ blockNumber: at.blockNumber })).hash === at.blockHash,
      "REORG", "Launch observation changed; discard and prepare again");
  }
  async function verifyDeployment() {
    const at = await auctions.verifyDeployment(); fresh(at); const blockNumber = at.blockNumber;
    for (const pin of [pins.creatorAccountFactory, pins.entryController, pins.bondEscrow]) {
      const code = await rpc.getCode({ address: pin.address, blockNumber });
      check(code && code !== "0x" && sameAddress(keccak256(code), pin.runtimeCodeHash), "CODE_MISMATCH", `Launch runtime differs at ${pin.address}`);
    }
    const [boundFactory, entry, bond, factoryController, factoryBond, bondController, fee, deposit, maxLaunchGasPrice, enabled, paused] = await Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "creatorAccountFactory", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "entryController", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "bondEscrow", blockNumber }),
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "auctionController", blockNumber }),
      rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "bondEscrow", blockNumber }),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "controller", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "launchFee", blockNumber }),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "CREATOR_DEPOSIT", blockNumber }),
      rpc.readContract({ address: pins.bondEscrow.address, abi: launchBondAbi, functionName: "MAX_GAS_PRICE", blockNumber }),
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "publicLaunchEnabled", blockNumber }),
      rpc.readContract({ address: pins.entryController.address, abi: launchEntryAbi, functionName: "entriesPaused", blockNumber }),
    ]);
    check(sameAddress(boundFactory, factory) && sameAddress(entry, pins.entryController.address)
      && sameAddress(bond, pins.bondEscrow.address) && sameAddress(factoryBond, bond)
      && sameAddress(factoryController, controller) && sameAddress(bondController, controller),
    "LAUNCH_BINDING_MISMATCH", "Launch controller, factory, entry or bond binding mismatch");
    check(fee === BigInt(pins.launchFeeBaseUnits) && deposit === BigInt(pins.deployerBondWei),
      "LAUNCH_COST_MISMATCH", "On-chain launch fee or bond differs from reviewed terms");
    await canonical(at);
    return { ...at, deployment, launchFee: fee, deployerBondWei: deposit, maxLaunchGasPrice, publicLaunchEnabled: enabled, entriesPaused: paused };
  }
  async function accountAt(owner: Address, dealId: Hex, at: Anchor) {
    const blockNumber = at.blockNumber;
    const account = await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "accountFor", args: [owner, dealId], blockNumber });
    if (sameAddress(account, zeroAddress)) return null;
    address(account);
    const registered = await rpc.readContract({ address: factory, abi: creatorAccountFactoryAbi, functionName: "isAccount", args: [account], blockNumber });
    const code = await rpc.getCode({ address: account, blockNumber });
    check(registered && code && code !== "0x", "INVALID_CREATOR_ACCOUNT", "Creator account must be registered by the pinned factory");
    const read = <N extends "controller" | "initialController" | "bondBeneficiary" | "beneficiary" | "dealId" | "auctionController" | "quoteAsset" | "bondEscrow" | "launched" | "coin">(functionName: N) =>
      rpc.readContract({ address: account, abi: creatorAccountAbi, functionName, blockNumber });
    const [current, initial, beneficiary, bondBeneficiary, id, auctionController, quote, bond, launched, coin] = await Promise.all([
      read("controller"), read("initialController"), read("beneficiary"), read("bondBeneficiary"), read("dealId"),
      read("auctionController"), read("quoteAsset"), read("bondEscrow"), read("launched"), read("coin"),
    ]);
    check(sameAddress(initial, owner) && sameAddress(bondBeneficiary, owner) && sameAddress(id, dealId)
      && sameAddress(auctionController, controller) && sameAddress(quote, deployment.quoteToken.address)
      && sameAddress(bond, pins.bondEscrow.address), "CREATOR_BINDING_MISMATCH", "Creator identity or launch contract binding differs");
    // A later handover does not undo an already-completed launch or transfer the original bond.
    check(launched || (sameAddress(current, owner) && sameAddress(beneficiary, owner)),
      "CREATOR_BINDING_MISMATCH", "Unlaunched account must retain the requested owner and beneficiary");
    return { creatorAccount: account, launched, coin, controller: current, beneficiary, bondBeneficiary };
  }
  async function getLaunch(input: { owner: Address; dealId: Hex }) {
    address(input.owner); hash(input.dealId);
    const at = await verifyDeployment(), state = await accountAt(input.owner, input.dealId, at);
    if (state?.launched) {
      const auction = await auctions.getAuction(input.dealId);
      check(sameAddress(auction.coin, state.coin), "LAUNCH_BINDING_MISMATCH", "Launched account coin does not match auction");
      const deal = await rpc.readContract({ address: deployment.registry.address, abi: registryAbi,
        functionName: "deal", args: [input.dealId], blockNumber: at.blockNumber });
      check(sameAddress(deal.creator, state.creatorAccount), "LAUNCH_BINDING_MISMATCH", "Auction belongs to another creator account");
      await canonical(at);
      return { ...at, ...state, dealId: input.dealId, auction: auction.auction };
    }
    await canonical(at);
    return { ...at, ...state, dealId: input.dealId, creatorAccount: state?.creatorAccount ?? null, launched: false as const, auction: null };
  }
  async function prepareLaunch(input: AuctionLaunchInput) {
    validateAuctionLaunch(input);
    const state = await getLaunch(input);
    if (state.launched) return { ...state, stage: "complete" as const, transaction: null };
    check(state.publicLaunchEnabled && !state.entriesPaused, "LAUNCH_PAUSED", "Public launches are disabled or paused");
    const blockNumber = state.blockNumber, localFloor = quoteAuctionFloor(input.floorPriceWad);
    const [available, deal, floor, balance, nativeBalance, pending, confirmed, gasPrice] = await Promise.all([
      rpc.readContract({ address: controller, abi: launchControllerAbi, functionName: "isTickerAvailable", args: [input.symbol], blockNumber }),
      rpc.readContract({ address: deployment.registry.address, abi: registryAbi, functionName: "deal", args: [input.dealId], blockNumber }),
      rpc.readContract({ address: deployment.auctionBindings.adapter.address, abi: launchFloorAbi, functionName: "effectiveFloor", args: [input.floorPriceWad], blockNumber }),
      rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi, functionName: "balanceOf", args: [input.owner], blockNumber }),
      rpc.getBalance({ address: input.owner, blockNumber }),
      rpc.getTransactionCount({ address: input.owner, blockTag: "pending" }),
      rpc.getTransactionCount({ address: input.owner, blockTag: "latest" }), rpc.getGasPrice(),
    ]);
    check(available, "TICKER_UNAVAILABLE", "Ticker is already in use");
    check(sameAddress(deal.creator, zeroAddress), "DEAL_ID_USED", "Deal ID is already in use; do not create a new identity to retry");
    check(floor[0] === localFloor.floorPriceQ96 && floor[1] === localFloor.tickSpacingQ96,
      "FLOOR_MISMATCH", "RPC floor differs from local adapter calculation");
    check(balance >= state.launchFee, "INSUFFICIENT_QUOTE", "Creator needs the USDC launch fee");
    check(nativeBalance >= state.deployerBondWei, "INSUFFICIENT_BOND", "Creator needs the native operating bond plus gas");
    check(pending === confirmed, "PENDING_TRANSACTION", "Resolve the wallet's pending transaction before preparing again");
    let stage: "setup" | "reset" | "approve" | "launch" = "setup";
    let transaction: AuctionLaunchTransaction = buildCreatorAccount({ deployment, owner: input.owner, dealId: input.dealId });
    if (state.creatorAccount) {
      const allowance = await rpc.readContract({ address: deployment.quoteToken.address, abi: tokenAbi,
        functionName: "allowance", args: [input.owner, state.creatorAccount], blockNumber });
      stage = allowance >= state.launchFee ? "launch" : allowance === 0n ? "approve" : "reset";
      transaction = stage === "launch" ? buildAuctionLaunch({ ...input, deployment, creatorAccount: state.creatorAccount })
        : { chainId: deployment.chainId, to: deployment.quoteToken.address, value: 0n,
          data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [state.creatorAccount, stage === "reset" ? 0n : state.launchFee] }) };
    }
    check(gasPrice > 0n, "INVALID_GAS_PRICE", "RPC must return a positive gas price");
    check(stage !== "launch" || gasPrice <= state.maxLaunchGasPrice,
      "GAS_PRICE_TOO_HIGH", "Current gas price exceeds the bond contract's launch cap; wait and prepare again");
    transaction = { ...transaction, gasPrice };
    const simulation = await rpc.call({ ...transaction, account: input.owner, blockNumber });
    if (stage === "approve" || stage === "reset") check(simulation.data === undefined || simulation.data === "0x"
      || simulation.data === `0x${"0".repeat(63)}1`, "APPROVAL_REJECTED", "Token approval returned false or malformed data");
    const gasEstimate = await rpc.estimateGas({ ...transaction, account: input.owner, blockNumber });
    const estimatedGasCost = ceil(gasEstimate * gasPrice * 120n, 100n);
    check(nativeBalance >= state.deployerBondWei + estimatedGasCost, "INSUFFICIENT_GAS", "Reserve the operating bond plus gas for this step");
    await canonical(state);
    check(await rpc.getTransactionCount({ address: input.owner, blockTag: "pending" }) === pending,
      "NONCE_CHANGED", "Wallet activity changed during preparation; prepare again");
    return { ...state, stage, transaction, owner: input.owner, ...localFloor, quoteBalance: balance, nativeBalance,
      nonce: pending, gasEstimate, estimatedGasCost, expiresAt: state.timestamp + BigInt(maxAge), simulated: true as const };
  }
  return { deployment, verifyDeployment, getLaunch, prepareLaunch };
}
