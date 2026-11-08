import { parseAbi } from "viem";
export * from "./auction-abis.js";
export * from "./curve-abis.js";

export const registryAbi = parseAbi([
  "function deal(bytes32) view returns ((address creator,address coin,address controller,address reserveAsset,uint8 profile,uint8 status,uint64 createdAt,uint64 activatedAt,bytes32 profileDigest))",
]);
export const tokenAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
