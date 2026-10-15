/**
 * Runs one request at a time for a view: starting a new one aborts the previous request, and a
 * response that arrives after a newer request started is dropped instead of overwriting newer results.
 */
export function createLatestRequest() {
  let sequence = 0;
  let controller: AbortController | null = null;
  return {
    async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<{ current: true; value: T } | { current: false }> {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      const id = ++sequence;
      try {
        const value = await request(own.signal);
        return id === sequence ? { current: true, value } : { current: false };
      } catch (error) {
        if (id !== sequence) return { current: false };
        throw error;
      }
    },
    cancel(): void {
      sequence += 1;
      controller?.abort();
      controller = null;
    },
  };
}
