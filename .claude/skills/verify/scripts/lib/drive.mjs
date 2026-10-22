// Driving an instance with headless Chromium and recording evidence. A flow opens a page, runs
// scenarios through a recorder, and finishes it; the recorder writes the screenshots and
// results.json into the instance's evidence folder (.local/ticket-artifacts/<issue>/).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { sleep } from './wait.mjs';

/** A headless page on the instance's UI, zh-TW, Taipei time, dark scheme by default. */
export async function openPage(instance, { viewport = { width: 1280, height: 860 }, colorScheme = 'dark', route = '/' } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  await page.goto(`${instance.url}${route}`);
  await page.locator('[data-testid^="page-"]').first().waitFor({ timeout: 30_000 });
  return { browser, context, page, consoleErrors, close: () => browser.close() };
}

/**
 * Records scenarios for one flow. `scenario(id, title, body)` runs `body({ expect, shot, themed, note })`:
 * `expect(ok, text)` records a check, `shot(name)` saves `<id>-<name>.png`, `themed(name)` saves
 * dark and light variants, `note(key, value)` keeps an observation. A throw fails the scenario and
 * saves `<id>-error.png`. `finish(extra)` writes results.json and returns whether every scenario passed.
 */
export function recorder(instance, page, { file = 'results.json' } = {}) {
  const results = [];
  const shots = [];
  const save = async (name) => {
    const target = path.join(instance.evidence, `${name}.png`);
    await page.screenshot({ path: target });
    shots.push(path.basename(target));
    return target;
  };
  return {
    shot: save,
    async scenario(id, title, body) {
      const checks = [];
      const observations = {};
      const expect = (ok, text) => {
        checks.push({ ok: Boolean(ok), text });
        if (!ok) console.log(`  ✗ ${id}: ${text}`);
      };
      const shot = (name) => save(`${id}-${name}`);
      const themed = async (name) => {
        for (const scheme of ['dark', 'light']) {
          await page.emulateMedia({ colorScheme: scheme });
          await sleep(250);
          await shot(`${name}-${scheme}`);
        }
        await page.emulateMedia({ colorScheme: 'dark' });
      };
      try {
        await body({ expect, shot, themed, note: (key, value) => { observations[key] = value; } });
      } catch (error) {
        checks.push({ ok: false, text: `例外：${String(error.message).split('\n')[0]}` });
        await shot('error').catch(() => undefined);
      }
      const pass = checks.length > 0 && checks.every((check) => check.ok);
      results.push({ id, title, pass, checks, observations });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${title}`);
      return pass;
    },
    async finish(extra = {}) {
      const passed = results.every((result) => result.pass);
      await writeFile(path.join(instance.evidence, file), JSON.stringify({
        issue: instance.issue, commit: instance.commit, dirty: instance.dirty, data: instance.data,
        layer: 'Web 模式（headless Chromium）', url: instance.url, finishedAt: new Date().toISOString(),
        passed, results, shots, ...extra,
      }, null, 2));
      return passed;
    },
  };
}

/** The state a proof checks besides the screen: what the same API the UI calls reports. */
export async function apiState(instance) {
  const read = (pathname) => instance.api(pathname).catch((error) => ({ error: error.message }));
  return {
    vault: await read('/api/vault/status'),
    subscriptions: await read('/api/subscriptions'),
    jobs: await read('/api/jobs/overview'),
    documents: await read('/api/documents?limit=100'),
    search: await read('/api/search/status'),
  };
}
