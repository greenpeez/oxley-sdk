import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { AgentApiError, agentKeyMessage, agentMcpServer, agentTransaction, checkAgentSteps, createOxleyAgentClient, OXLEY_AGENT_API_URL, prepareAgentKeyRequest,
  requestAgentApiKey, type AgentStep } from "../src/agents.js";

const account = privateKeyToAccount(`0x${"7".repeat(64)}`), apiKey = `oxk_${"A".repeat(43)}`;
const usdc = "0xb88339cb7199b77e23db6e890353e22632ba630f", hype = "0x5555555555555555555555555555555555555555", fee = { recipient: `0x${"9".repeat(40)}` as const, bps: 50 };
const hash = `0x${"a".repeat(64)}` as const;
type Seen = { url: URL; method: string; headers: Record<string, string>; body?: unknown };
function transport(answers: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>, seen: Seen[] = []): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    seen.push({ url: new URL(String(input)), method: init?.method ?? "GET", headers, ...init?.body ? { body: JSON.parse(String(init.body)) } : {} });
    const answer = answers.shift() ?? { body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
  }) as typeof fetch;
}
const code = (expected: string, status?: number) => (error: unknown) => error instanceof AgentApiError && error.code === expected && (status === undefined || error.status === status);

test("agent keys: the exact key message, signed by the caller's own signer and sent as { address, issuedAt, signature } with no key (the API's keys.ts rule)", async () => {
  const lower = account.address.toLowerCase(), ask = prepareAgentKeyRequest(lower, Date.UTC(2026, 10, 13, 9, 30));
  assert.deepEqual(ask, { address: account.address, issuedAt: "2026-11-13T09:30:00.000Z", message: `Oxley API key\nAddress: ${account.address}\nIssued at: 2026-11-13T09:30:00.000Z` });
  assert.equal(agentKeyMessage(lower, ask.issuedAt), ask.message, "the message carries the checksummed address whatever the case given");
  const seen: Seen[] = [], issued = { key: apiKey, owner: lower, tier: "starter" };
  const answer = await requestAgentApiKey({ signer: account, now: Date.UTC(2026, 10, 13, 9, 30), fetch: transport([{ status: 201, body: issued }], seen) });
  assert.deepEqual(answer, issued);
  const [sent] = seen;
  assert.equal(sent!.url.toString(), `${OXLEY_AGENT_API_URL}/v1/keys`); assert.equal(sent!.method, "POST"); assert.equal(sent!.headers.authorization, undefined);
  const body = sent!.body as { address: `0x${string}`; issuedAt: string; signature: `0x${string}` };
  assert.deepEqual([body.address, body.issuedAt], [account.address, ask.issuedAt]);
  assert.ok(await verifyMessage({ address: account.address, message: ask.message, signature: body.signature }), "the signature is the account's signature of the message");
  assert.throws(() => prepareAgentKeyRequest("0x1234"), code("INVALID_REQUEST"));
});

test("agent client: every endpoint's method, path, Bearer key, query and body, with the integrator fee as the price query's two fields", async () => {
  const seen: Seen[] = [], client = createOxleyAgentClient({ apiKey, fetch: transport([], seen) });
  const intent = { account: account.address, recipient: account.address, sourceChainId: 8453, destinationChainId: 99901, tokenIn: `0x${"1".repeat(40)}` as const, tokenOut: usdc,
    amountIn: "10000000", integratorFee: fee };
  await client.me();
  await client.swapTokens();
  await client.swapPrice({ sellToken: usdc, buyToken: hype, sellAmount: "10000000", slippageBps: 50, integratorFee: fee });
  await client.buildSwap({ sellToken: usdc, buyToken: hype, sellAmount: "10000000", taker: account.address });
  await client.swapStatus({ hash, buildId: "b1" });
  await client.bridgeConfig();
  await client.bridgeQuote(intent);
  await client.buildBridge({ ...intent, via: "enso" });
  await client.bridgeStatus({ chainId: 8453, txHash: hash, buildId: "b2" });
  await client.report({ buildId: "b2", txHash: hash });
  await client.revokeKey();
  await client.openApi();
  assert.deepEqual(seen.map(call => `${call.method} ${call.url.pathname}`), ["GET /v1/me", "GET /v1/swap/tokens", "GET /v1/swap/price", "POST /v1/swap/build", "GET /v1/swap/status",
    "GET /v1/bridge/config", "POST /v1/bridge/quote", "POST /v1/bridge/build", "POST /v1/bridge/status", "POST /v1/report", "DELETE /v1/keys/self", "GET /v1/openapi.json"]);
  assert.ok(seen.slice(0, -1).every(call => call.headers.authorization === `Bearer ${apiKey}`)); assert.equal(seen.at(-1)!.headers.authorization, undefined, "the OpenAPI file needs no key");
  assert.deepEqual(Object.fromEntries(seen[2]!.url.searchParams), { sellToken: usdc, buyToken: hype, sellAmount: "10000000", slippageBps: "50", integratorFeeRecipient: fee.recipient, integratorFeeBps: "50" });
  assert.deepEqual(Object.fromEntries(seen[4]!.url.searchParams), { hash, buildId: "b1" });
  assert.deepEqual(seen[7]!.body, { ...intent, via: "enso" }); assert.equal(seen[7]!.headers["content-type"], "application/json");
  assert.deepEqual(seen[9]!.body, { buildId: "b2", txHash: hash });
});

test("agent client: a 429 is waited out once by default and then thrown with retryAfterMs; the API's { error, reason } becomes AgentApiError; bad input is refused before sending", async () => {
  const limited = { status: 429, body: { error: "RATE_LIMITED", reason: "Over this key's per-minute quote limit (starter tier)." }, headers: { "retry-after": "0" } };
  const seen: Seen[] = [], retried = createOxleyAgentClient({ apiKey, fetch: transport([limited, { body: { tier: "starter" } }], seen) });
  assert.deepEqual(await retried.me(), { tier: "starter" }); assert.equal(seen.length, 2);
  const long = createOxleyAgentClient({ apiKey, fetch: transport([{ ...limited, headers: { "retry-after": "60" } }]) });
  await assert.rejects(long.me(), (error: unknown) => code("RATE_LIMITED", 429)(error) && (error as AgentApiError).retryAfterMs === 60_000 && /per-minute/.test((error as AgentApiError).reason!));
  const refused = createOxleyAgentClient({ apiKey, fetch: transport([{ status: 400, body: { error: "INVALID_INTEGRATOR_FEE", reason: "integratorFee is { recipient, bps }" } }]) });
  await assert.rejects(refused.buildSwap({ sellToken: usdc, buyToken: hype, sellAmount: "1", taker: account.address, integratorFee: fee }), code("INVALID_INTEGRATOR_FEE", 400));
  await assert.rejects(createOxleyAgentClient({ apiKey, fetch: transport([{ status: 502, body: "<html>" }]) }).me(), code("HTTP_ERROR", 502));
  const untouched: Seen[] = [], local = createOxleyAgentClient({ apiKey, fetch: transport([], untouched) });
  assert.throws(() => local.swapPrice({ sellToken: usdc, buyToken: hype, sellAmount: "1", slippageBps: 5 }), code("INVALID_REQUEST"));
  assert.throws(() => local.buildSwap({ sellToken: usdc, buyToken: hype, sellAmount: "0", taker: account.address }), code("INVALID_REQUEST"));
  assert.throws(() => local.report({ buildId: "b", txHash: "0x12" as `0x${string}` }), code("INVALID_REQUEST"));
  assert.equal(untouched.length, 0);
  await assert.rejects(createOxleyAgentClient({ fetch: transport([]) }).me(), code("API_KEY_REQUIRED"));
  assert.throws(() => createOxleyAgentClient({ baseUrl: "http://oxley.example" }), code("INVALID_CLIENT_OPTIONS"));
  assert.throws(() => createOxleyAgentClient({ apiKey: "sk-123" }), code("INVALID_CLIENT_OPTIONS"));
  const slow = createOxleyAgentClient({ apiKey, timeoutMs: 20, fetch: ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch });
  await assert.rejects(slow.me(), code("TIMEOUT"));
});

test("agent steps: the local pre-signing check, the viem transaction request, and the MCP server entry", () => {
  const tx = { chainId: 99901, from: account.address, to: usdc as `0x${string}`, data: "0x095ea7b3" as const, value: "0" };
  const steps: AgentStep[] = [{ kind: "approval", label: "Approve", tx }, { kind: "transaction", label: "Swap", tx: { ...tx, to: hype as `0x${string}`, value: "5", gas: "210000" } }];
  assert.equal(checkAgentSteps(steps, { account: account.address, chainId: 99901 }), steps);
  assert.throws(() => checkAgentSteps(steps, { account: `0x${"2".repeat(40)}` }), code("UNEXPECTED_STEPS"));
  assert.throws(() => checkAgentSteps(steps, { account: account.address, chainId: 8453 }), code("UNEXPECTED_STEPS"));
  assert.throws(() => checkAgentSteps([steps[0]!], { account: account.address }), code("UNEXPECTED_STEPS"), "the last step must be the build's transaction");
  assert.throws(() => checkAgentSteps([], { account: account.address }), code("UNEXPECTED_STEPS"));
  assert.deepEqual(agentTransaction(steps[1]!), { chainId: 99901, to: hype, data: "0x095ea7b3", value: 5n, gas: 210000n });
  assert.deepEqual(agentMcpServer(apiKey), { type: "http", url: `${OXLEY_AGENT_API_URL}/mcp`, headers: { Authorization: `Bearer ${apiKey}` } });
});
