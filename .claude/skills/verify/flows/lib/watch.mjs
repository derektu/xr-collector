// Sampling what a page shows while a flow runs. A MutationObserver inside the page calls `collect()`,
// which returns { key: value } for what is on screen now, and keeps every change of each key with its
// time. `collect()` reads only the DOM, so every change it can see comes with a mutation. The log
// lives in the page, so it covers changes between the flow's own steps.

/**
 * Starts sampling on `page` under `name`. `collect` runs inside the page, must be self-contained
 * (no closure over flow variables) and must read only the DOM.
 */
export async function watch(page, name, collect) {
  await page.evaluate(({ name, source }) => {
    const collect = new Function(`return (${source})`)();
    const logs = (window.__verifyWatch ??= {});
    const log = (logs[name] = {});
    const sample = () => {
      const at = Date.now();
      for (const [key, value] of Object.entries(collect())) {
        const samples = (log[key] ??= []);
        if (samples.at(-1)?.value !== value) samples.push({ at, value });
      }
    };
    sample();
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, { name, source: collect.toString() });
}

/** The samples so far: { key: [{ at, value }] }. */
export function watched(page, name) {
  return page.evaluate((name) => window.__verifyWatch?.[name] ?? {}, name);
}
