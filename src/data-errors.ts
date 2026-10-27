export class DataApiError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfterMs?: number) {
    super(code); this.name = "DataApiError";
  }
}
