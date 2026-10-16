import { createOxleyDataClient, DataApiError, isCurrentData, type IndexedData, type Auction } from '@oxley/sdk/data';

/** Call stop() on unmount. The host supplies its render/error handling and API root. */
export function watchAuctions(baseUrl: string, chainId: number,
  render: (page: IndexedData<Auction>, current: boolean) => void,
  onError: (error: unknown) => void) {
  const data = createOxleyDataClient({ baseUrl, chainId });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
  async function refresh() {
    let delay = 15_000;
    try {
      if (typeof document !== 'undefined' && document.hidden
        || typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const page = await data.auctions({ model: 'cca', limit: 20 }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      failures = 0;
      render(page, isCurrentData(page)); // Recheck at render time if retaining the page later.
    } catch (error) {
      if (controller.signal.aborted) return;
      failures++;
      delay = Math.max(Math.min(120_000, 15_000 * 2 ** Math.min(failures, 3)),
        error instanceof DataApiError ? error.retryAfterMs ?? 0 : 0);
      onError(error); // Keep the previous observation visibly delayed; never replace it with invented zeros.
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, delay + Math.random() * 1000);
    }
  }
  void refresh();
  return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
}
