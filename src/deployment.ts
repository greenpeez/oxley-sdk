import { BID_RULES } from "./bid-rules.js";
import { address, check, hash, sameAddress } from "./validation.js";
import type { ContractPin, Deployment } from "./types.js";

const TESTNET_QUOTE_TOKEN = "0xa4ce6e6c719f7fb524230c367948039b078683e4";
function deploymentHeader(input: unknown): Deployment {
  check(!!input && typeof input === "object", "INVALID_DEPLOYMENT", "Deployment manifest required");
  const d = input as Deployment;
  check(d.schemaVersion === 1 && typeof d.releaseId === "string" && d.releaseId.length > 0,
    "INVALID_DEPLOYMENT", "Unsupported deployment schema or empty release ID");
  check(Number.isSafeInteger(d.chainId) && d.chainId > 0, "INVALID_CHAIN", "A positive chain ID is required");
  check(d.network === "testnet" || d.network === "mainnet", "INVALID_NETWORK", "Explicit network required");
  check(typeof d.startBlock === "string" && /^(0|[1-9][0-9]*)$/.test(d.startBlock),
    "INVALID_START_BLOCK", "startBlock must be a decimal block number");
  for (const text of [d.status, d.note]) check(text === undefined || (typeof text === "string" && text.length > 0),
    "INVALID_DEPLOYMENT", "status and note must be non-empty strings when present");
  return d;
}
function bidRules(rules: unknown): typeof BID_RULES {
  check(!!rules && typeof rules === "object" && Object.keys(rules).length === Object.keys(BID_RULES).length
    && Object.entries(BID_RULES).every(([key, value]) => (rules as Record<string, unknown>)[key] === value),
  "INVALID_BID_RULES", "The manifest's bid rules must be exactly the compiled Dynamic Bid rules");
  return rules as typeof BID_RULES;
}
const freezePin = <T extends ContractPin>(pin: T): T => Object.freeze({ ...pin });

/** Validates and freezes a deployment manifest. Offline: runtime code and bindings are verified against a chain by the clients' `verifyDeployment`. */
export function parseDeployment(input: unknown): Deployment {
  const d = deploymentHeader(input), bindings = d.auctionBindings;
  check(!!bindings && typeof bindings === "object", "AUCTION_BINDINGS_REQUIRED", "Reviewed auction runtime pins are required");
  hash(bindings.controllerRuntimeCodeHash);
  const pins = [d.curve, d.registry, d.quoteToken, d.termsRegistry, bindings.bidRouter, bindings.adapter, bindings.bidHook, bindings.exposureHelper];
  for (const pin of pins) {
    check(!!pin && typeof pin === "object", "AUCTION_BINDINGS_REQUIRED", "Missing contract pin");
    address(pin.address); hash(pin.runtimeCodeHash);
  }
  address(d.auctionController);
  check(d.quoteToken.decimals === 6 && d.quoteToken.symbol === (d.network === "mainnet" ? "USDC" : "Oxy-USDC"),
    "INVALID_QUOTE_ASSET", "Mainnet requires USDC; testnet requires Oxy-USDC, both with six decimals");
  check(d.network !== "mainnet" || (d.chainId !== 99801 && !sameAddress(d.quoteToken.address, TESTNET_QUOTE_TOKEN)),
    "TESTNET_ON_MAINNET", "Testnet bindings cannot be used on mainnet");
  const addresses = [d.auctionController, ...pins.map(pin => pin.address)];
  check(new Set(addresses.map(a => a.toLowerCase())).size === addresses.length,
    "INVALID_DEPLOYMENT", "Curve, registry, quote token, terms registry, controller and auction contracts must be distinct");
  const rules = bidRules(d.bidRules);
  return Object.freeze({ ...d, curve: freezePin(d.curve), registry: freezePin(d.registry), quoteToken: freezePin(d.quoteToken),
    termsRegistry: freezePin(d.termsRegistry),
    auctionBindings: Object.freeze({ ...bindings, bidRouter: freezePin(bindings.bidRouter), adapter: freezePin(bindings.adapter),
      bidHook: freezePin(bindings.bidHook), exposureHelper: freezePin(bindings.exposureHelper) }),
    bidRules: Object.freeze({ ...rules }) });
}
