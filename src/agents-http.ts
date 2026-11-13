import { dataAbortScope } from "./data-abort.js";
import { DataApiError } from "./data-errors.js";
import { readJson, retryDelay } from "./data-http.js";

/**
 * A refused or failed Agent API call. `code` is the API's own (`RATE_LIMITED`, `BUSY`, `API_KEY_INVALID`, `INVALID_INTEGRATOR_FEE`, ...) or one of the client's: `INVALID_REQUEST`
 * (refused before sending), `API_KEY_REQUIRED`, `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`, `INVALID_RESPONSE`, `RESPONSE_TOO_LARGE`, `HTTP_ERROR`. `reason` is the API's plain-words reason.
 */
export class AgentApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly reason?: string, readonly retryAfterMs?: number, readonly body?: unknown) {
    super(reason ? `${code}: ${reason}` : code); this.name = "AgentApiError";
  }
}

export type Transport = typeof globalThis.fetch;
export type HttpOptions = Readonly<{ root: URL; apiKey?: string; fetch?: Transport; timeoutMs: number; retries: number; maxRetryWaitMs: number }>;
export type Call = Readonly<{ method: "GET" | "POST" | "DELETE"; path: string; query?: URLSearchParams; body?: unknown; auth: boolean; signal?: AbortSignal }>;

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function refusal(response: Response, payload: unknown): AgentApiError {
  const code = record(payload) && typeof payload.error === "string" && CODE.test(payload.error) ? payload.error : "HTTP_ERROR";
  const reason = record(payload) ? [payload.reason, payload.message].find(text => typeof text === "string") as string | undefined : undefined;
  return new AgentApiError(code, response.status, reason, retryDelay(response), payload);
}
const pause = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new AgentApiError("ABORTED")); return; }
  const done = () => { signal?.removeEventListener("abort", stop); resolve(); };
  const timer = setTimeout(done, milliseconds);
  function stop() { clearTimeout(timer); reject(new AgentApiError("ABORTED")); }
  signal?.addEventListener("abort", stop, { once: true });
});

async function once<T>(options: HttpOptions, call: Call): Promise<T> {
  const url = new URL(call.path.replace(/^\//u, ""), options.root);
  if (call.query) url.search = call.query.toString();
  const headers: Record<string, string> = { accept: "application/json" };
  if (call.auth) headers.authorization = `Bearer ${options.apiKey}`;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  const scope = dataAbortScope(call.signal, options.timeoutMs), transport = options.fetch ?? globalThis.fetch;
  try {
    const response = await transport(url, { method: call.method, headers, ...call.body === undefined ? {} : { body: JSON.stringify(call.body) },
      credentials: "omit", redirect: "error", cache: "no-store", signal: scope.signal });
    let payload: unknown;
    try { payload = await readJson(response); } catch (error) { if (response.ok) throw error; }
    if (!response.ok) throw refusal(response, payload);
    return payload as T;
  } catch (error) {
    if (call.signal?.aborted) throw new AgentApiError("ABORTED");
    if (scope.timedOut()) throw new AgentApiError("TIMEOUT");
    if (error instanceof AgentApiError) throw error;
    if (error instanceof DataApiError) throw new AgentApiError(error.code, error.status);
    throw new AgentApiError("NETWORK_ERROR");
  } finally { scope.dispose(); }
}

/**
 * One call of the API. A 429 (the key's limit, or the API's `BUSY` ceiling) did nothing on the server, so it is waited out and sent again, up to `retries` times, when its
 * `retry-after` is at most `maxRetryWaitMs`; otherwise its `AgentApiError` carries `retryAfterMs`.
 */
export async function agentCall<T>(options: HttpOptions, call: Call): Promise<T> {
  if (call.auth && !options.apiKey) throw new AgentApiError("API_KEY_REQUIRED", 0, "Pass apiKey to createOxleyAgentClient (requestAgentApiKey issues one).");
  for (let attempt = 0; ; attempt += 1) {
    try { return await once<T>(options, call); } catch (error) {
      const wait = error instanceof AgentApiError && error.status === 429 ? error.retryAfterMs ?? 1000 : undefined;
      if (wait === undefined || attempt >= options.retries || wait > options.maxRetryWaitMs) throw error;
      await pause(wait, call.signal);
    }
  }
}
