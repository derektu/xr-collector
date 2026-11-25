declare const page: { waitForTimeout(ms: number): Promise<void> };

export const signal = AbortSignal.timeout(1_000);
export const viaGlobal = globalThis.AbortSignal.timeout(1_000);
await page.waitForTimeout(500);
