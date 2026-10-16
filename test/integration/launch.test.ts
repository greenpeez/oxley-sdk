import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, createWalletClient, createTestClient, getContractAddress, http, keccak256,
  parseEventLogs, toHex, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { anvil } from "viem/chains";
import { createOxleyLaunchClient, creatorAccountAbi, creatorAccountFactoryAbi, type AuctionLaunchInput } from "../../src/launch.js";
import { auctionControllerAbi, ccaAuctionAbi } from "../../src/auctions.js";
import { tokenAbi } from "../../src/abis.js";

interface Artifact { abi: Abi; bytecode: Hex }
interface Step { kind: string; role?: string; artifact?: string; parent?: string; nonce?: string; target?: string; fn?: string; args?: unknown[] }
const artifact = async (name: string): Promise<Artifact> => JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("launch SDK executes the retained auction graph locally with recovery and no remote transactions", { timeout: 180_000 }, async t => {
  assert.ok(process.env.ANVIL_BIN, "Set ANVIL_BIN; this suite starts its own unforked local node");
  const port = await new Promise<number>(resolve => {
    const server = createServer(); server.listen(0, "127.0.0.1", () => {
      const info = server.address(); assert.ok(info && typeof info === "object"); server.close(() => resolve(info.port));
    });
  });
  const child = spawn(process.env.ANVIL_BIN, ["--port", String(port), "--host", "127.0.0.1", "--chain-id", "99801",
    "--hardfork", "osaka", "--gas-price", "100000000", "--base-fee", "0", "--silent"], { stdio: "ignore" });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); } });
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0 });
  // The retained testnet fee router checks this ID; endpoint remains our own unforked localhost node.
  const chain = { ...anvil, id: 99801 };
  const rpc = createPublicClient({ chain, transport, pollingInterval: 10, cacheTime: 0 });
  const wallet = createWalletClient({ chain, transport, pollingInterval: 10, cacheTime: 0 });
  const local = createTestClient({ chain, transport, mode: "anvil" });
  for (let i = 0; ; i++) { try { await rpc.getChainId(); break; } catch (e) { if (i >= 40) throw e; await delay(50); } }
  const [admin, owner, treasury, deliverySigner, other] = await wallet.getAddresses() as [Address, Address, Address, Address, Address];
  const confirmed = async (hash: Hex) => {
    const r = await rpc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") {
      const trace = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] }) }).then(r => r.json());
      const failures: unknown[] = [];
      const walk = (c: { to?: string; input?: string; output?: string; error?: string; gasUsed?: string; calls?: unknown[] }) => {
        if (c.error) failures.push({ to: c.to, selector: c.input?.slice(0, 10), output: c.output, error: c.error, gasUsed: c.gasUsed });
        for (const next of c.calls ?? []) walk(next as typeof c);
      };
      walk(trace.result); throw new Error(`Local transaction reverted: ${JSON.stringify(failures)}`);
    }
    return r;
  };
  const deploy = async (a: Artifact, args: readonly unknown[] = []) => {
    const receipt = await confirmed(await wallet.deployContract({ ...a, args, account: admin, gas: 15_000_000n }));
    assert.ok(receipt.contractAddress); return receipt.contractAddress;
  };
  const token = await artifact("IntegrationToken"), price = await artifact("IntegrationPrice");
  const roles: Record<string, Address> = { admin, launchOwner: admin, treasury, deliverySigner, attestor: admin,
    quote: await deploy(token, [6]), priceAdapter: await deploy(price),
    ccaFactory: await deploy(await artifact("ContinuousClearingAuctionFactory"), [zeroAddress]) };
  const permit = JSON.parse(await readFile(new URL("../fixtures/Permit2Runtime.json", import.meta.url), "utf8"));
  assert.equal(keccak256(permit.code), "0x2cb311778aae1e57e25c84b36770ee4008be8c7f79c0d3fb4f2aa30be2626600");
  await local.setCode({ address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", bytecode: permit.code });
  await local.setCode({ address: toHex(100, { size: 20 }), bytecode: "0x4360005260206000f3" });
  const raw = await readFile(new URL("../fixtures/LaunchGraph.json", import.meta.url));
  const proof = JSON.parse(await readFile(new URL("../../docs/launch-artifacts.json", import.meta.url), "utf8"));
  assert.equal(createHash("sha256").update(raw).digest("hex"), proof.graphFixtureSha256);
  const graph = JSON.parse(raw.toString()) as { recipe: Step[]; artifacts: Record<string, Artifact> };
  const settings: Record<string, bigint | Hex> = { curveMaximumPriceAge: 3600n, auctionProfileDigest: toHex(1, { size: 32 }),
    auctionLaunchFee: 1_500_000n, auctionMinimumRaise: 50_000_000_000n, auctionFeeMode: 0n,
    auctionMaxBids: 0n, auctionMinimumBid: 0n, auctionMaxOutstandingBids: 0n,
    deliveryGasWeiPerBid: 350_000_000_000_000n, deliveryBaseGasWeiPerAuction: 20_000_000_000_000_000n,
    deliveryMinimumSignerReserveWei: 10_000_000_000_000_000n, reserveProfileDigest: toHex(2, { size: 32 }), reserveLaunchFee: 1_500_000n };
  const byRole: Record<string, Artifact> = {};
  async function value(v: unknown): Promise<unknown> {
    if (Array.isArray(v)) return Promise.all(v.map(value));
    if (v && typeof v === "object") {
      const ref = v as Record<string, string>;
      if (ref.$role) { assert.ok(roles[ref.$role]); return roles[ref.$role]; }
      if (ref.$setting) { assert.ok(ref.$setting in settings); return settings[ref.$setting]; }
      if (ref.$runtimeHash) return keccak256((await rpc.getCode({ address: roles[ref.$runtimeHash]! }))!);
    }
    return v;
  }
  async function send(role: string, functionName: string, args: readonly unknown[]) {
    return confirmed(await wallet.writeContract({ address: roles[role]!, abi: byRole[role]!.abi, functionName, args, account: admin }));
  }
  for (const step of graph.recipe) {
    if (step.kind === "create") {
      const a = graph.artifacts[step.artifact!]!; assert.ok(a);
      try { roles[step.role!] = await deploy(a, await Promise.all(step.args!.map(value))); }
      catch (cause) { throw new Error(`Local fixture deployment failed: ${step.role}`, { cause }); }
      byRole[step.role!] = a;
    } else if (step.kind === "child") {
      roles[step.role!] = getContractAddress({ from: roles[step.parent!]!, nonce: BigInt(step.nonce!) });
    } else await send(step.target!, step.fn!, await Promise.all(step.args!.map(value)));
  }
  await send("auctionController", "enablePublicLaunch", []);
  await send("entry", "setEntriesPaused", [false]);
  await confirmed(await wallet.writeContract({ address: roles.quote!, abi: token.abi, functionName: "mint", args: [owner, 10_000_000n], account: admin }));
  const pin = async (role: string) => ({ address: roles[role]!, runtimeCodeHash: keccak256((await rpc.getCode({ address: roles[role]! }))!) });
  const deployment = { schemaVersion: 1, releaseId: "local-real-launch-graph", chainId: 99801, network: "testnet", startBlock: "1",
    curve: await pin("curve"), registry: await pin("registry"), quoteToken: { ...await pin("quote"), decimals: 6, symbol: "Oxy-USDC" },
    auctionController: roles.auctionController!, auctionBindings: { controllerRuntimeCodeHash: (await pin("auctionController")).runtimeCodeHash,
      bidRouter: await pin("bidRouter"), adapter: await pin("ccaAdapter") },
    launchBindings: { creatorAccountFactory: await pin("creatorAccountFactory"), entryController: await pin("entry"), bondEscrow: await pin("bondEscrow"),
      launchFeeBaseUnits: "1500000", deployerBondWei: "500000000000000000" } };
  const client = () => createOxleyLaunchClient({ publicClient: rpc, deployment });
  const input: AuctionLaunchInput = { owner, dealId: toHex(123, { size: 32 }), name: "SDK Launch", symbol: "SDKLAUNCH",
    floorPriceWad: 10n ** 19n, creatorLockDays: 30, listingCommitmentBps: 5000, auctionDurationHours: 1 };
  const quoteBalance = () => rpc.readContract({ address: roles.quote!, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
  let account: Address;
  await t.test("setup executes pinned factory and restart recovers exact creator account", async () => {
    const prep = await client().prepareLaunch(input); assert.equal(prep.stage, "setup"); assert.ok(prep.transaction);
    const receipt = await confirmed(await wallet.sendTransaction({ ...prep.transaction, account: owner, gas: 15_000_000n }));
    const event = parseEventLogs({ abi: creatorAccountFactoryAbi, logs: receipt.logs, eventName: "CreatorAccountCreated" })[0]!;
    account = event.args.account; assert.equal(event.args.controller.toLowerCase(), owner.toLowerCase());
    assert.equal(event.args.beneficiary.toLowerCase(), owner.toLowerCase());
    const next = await client().prepareLaunch(input); assert.equal(next.stage, "approve"); assert.equal(next.creatorAccount, account);
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...prep.transaction, account: owner, gas: 4_000_000n })));
  });
  await t.test("reset then exact fee approval survive restart; launch cannot be called by another wallet", async () => {
    await confirmed(await wallet.writeContract({ address: roles.quote!, abi: tokenAbi, functionName: "approve", args: [account, 1n], account: owner }));
    for (const stage of ["reset", "approve"] as const) {
      const prep = await client().prepareLaunch(input); assert.equal(prep.stage, stage); assert.ok(prep.transaction);
      await confirmed(await wallet.sendTransaction({ ...prep.transaction, account: owner }));
    }
    const prep = await client().prepareLaunch(input); assert.equal(prep.stage, "launch"); assert.ok(prep.transaction);
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...prep.transaction, account: other, gas: 12_000_000n })));
    await assert.rejects(rpc.call({ ...prep.transaction, gasPrice: 1_000_000_001n,
      account: owner, gas: 12_000_000n }), /0xc5fb504c/);
    assert.equal(await rpc.readContract({ address: account, abi: creatorAccountAbi, functionName: "launched" }), false);
  });
  await t.test("launch charges exact quote fee and native bond, preserves creator identity and installs auction", async () => {
    const prep = await client().prepareLaunch(input); assert.equal(prep.stage, "launch"); assert.ok(prep.transaction);
    const before = await quoteBalance(), native = await rpc.getBalance({ address: owner });
    assert.ok("gasEstimate" in prep);
    const receipt = await confirmed(await wallet.sendTransaction({ ...prep.transaction, account: owner, gas: prep.gasEstimate }));
    t.diagnostic(`launch gas used=${receipt.gasUsed}; estimated=${"gasEstimate" in prep ? prep.gasEstimate : "absent"}`);
    assert.equal(before - await quoteBalance(), 1_500_000n);
    assert.equal(native - await rpc.getBalance({ address: owner }), 500_000_000_000_000_000n + receipt.gasUsed * receipt.effectiveGasPrice);
    assert.equal(await rpc.readContract({ address: roles.quote!, abi: tokenAbi, functionName: "allowance", args: [owner, account] }), 0n);
    assert.equal(await rpc.readContract({ address: account, abi: creatorAccountAbi, functionName: "bondBeneficiary" }), owner);
    const opened = parseEventLogs({ abi: auctionControllerAbi, logs: receipt.logs, eventName: "CcaDealOpened" })[0]!;
    assert.equal(opened.args.creator, account); assert.equal(opened.args.name, input.name); assert.equal(opened.args.symbol, input.symbol);
    const commitment = parseEventLogs({ abi: creatorAccountAbi, logs: receipt.logs, eventName: "AuctionListingCommitted" })[0]!;
    assert.equal(commitment.args.commitmentBps, 5000);
    const result = await client().prepareLaunch(input);
    assert.equal(result.stage, "complete"); assert.equal(result.transaction, null); assert.ok(result.auction);
    assert.equal(result.coin, opened.args.coin);
    const [floor, spacing, currency] = await Promise.all([
      rpc.readContract({ address: result.auction, abi: ccaAuctionAbi, functionName: "floorPrice" }),
      rpc.readContract({ address: result.auction, abi: ccaAuctionAbi, functionName: "tickSpacing" }),
      rpc.readContract({ address: result.auction, abi: ccaAuctionAbi, functionName: "currency" }),
    ]);
    assert.ok("floorPriceQ96" in prep); assert.equal(floor, prep.floorPriceQ96); assert.equal(spacing, prep.tickSpacingQ96);
    assert.equal(currency.toLowerCase(), roles.quote!.toLowerCase());
    await assert.rejects(confirmed(await wallet.sendTransaction({ ...prep.transaction, account: owner, gas: 12_000_000n })));
  });
  await t.test("paused launches and duplicate ticker cannot produce another launch transaction", async () => {
    const another = { ...input, dealId: toHex(124, { size: 32 }) };
    await assert.rejects(client().prepareLaunch(another), /Ticker/);
    await send("entry", "setEntriesPaused", [true]);
    await assert.rejects(client().prepareLaunch({ ...another, symbol: "SDKNEW" }), /paused/);
    assert.equal((await client().getLaunch(input)).launched, true);
  });
});
