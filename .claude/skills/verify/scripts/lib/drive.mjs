// Driving an instance with headless Chromium and recording evidence. A flow opens a page, runs
// scenarios through a recorder, and finishes it; the recorder writes the screenshots and
// results.json into the instance's evidence folder (.local/ticket-artifacts/<issue>[/<label>]/).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { environment } from './platform.mjs';
import { sleep } from './wait.mjs';

/** What the UI shows once loaded: a page of the app, or Onboarding while no Vault is ready. */
export const LOADED = '[data-testid^="page-"], .onboarding-screen';

/** A headless page on the instance's UI, zh-TW, Taipei time, dark scheme by default. */
export async function openPage(instance, { viewport = { width: 1280, height: 860 }, colorScheme = 'dark', route = '/' } = {}) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    await page.goto(`${instance.url}${route}`);
    await page.locator(LOADED).first().waitFor({ timeout: 30_000 });
    return { browser, context, page, consoleErrors, close: () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/**
 * One check of results.json. `detail` ({ id, expected, actual }) gives the check a stable ID, so two
 * runs of a flow compare check by check, and says what was expected and what was seen.
 */
export function checkEntry(ok, text, detail) {
  if (!detail) return { ok: Boolean(ok), text };
  return { id: detail.id, ok: Boolean(ok), text, expected: detail.expected, actual: detail.actual };
}

/** The line printed for a failed check: its ID, text, and what was expected against what was seen. */
export function failureHint(text, detail) {
  if (!detail) return text;
  const show = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
  return `[${detail.id}] ${text}\n      預期：${show(detail.expected)}\n      實際：${show(detail.actual)}`;
}

/**
 * Records scenarios for one flow. `scenario(id, title, body)` runs `body({ expect, shot, themed, note })`:
 * `expect(ok, text, detail?)` records a check (see checkEntry), `shot(name, page?)` saves `<id>-<name>.png` (of another
 * page when given), `themed(name)` saves
 * dark and light variants, `note(key, value)` keeps an observation. A throw fails the scenario and
 * saves `<id>-error.png`. `finish(extra)` writes results.json and returns whether every scenario passed.
 * `page` may be a function returning the page, for a flow whose page changes (a relaunched Electron).
 */
export function recorder(instance, page, { file = 'results.json' } = {}) {
  const results = [];
  const shots = [];
  const current = () => (typeof page === 'function' ? page() : page);
  const save = async (name, from = current()) => {
    const target = path.join(instance.evidence, `${name}.png`);
    await from.screenshot({ path: target });
    shots.push(path.basename(target));
    return target;
  };
  return {
    shot: save,
    async scenario(id, title, body) {
      const checks = [];
      const observations = {};
      const expect = (ok, text, detail) => {
        checks.push(checkEntry(ok, text, detail));
        if (!ok) console.log(`  ✗ ${id}: ${failureHint(text, detail)}`);
      };
      const shot = (name, from) => save(`${id}-${name}`, from);
      const themed = async (name) => {
        for (const scheme of ['dark', 'light']) {
          await current().emulateMedia({ colorScheme: scheme });
          await sleep(250);
          await shot(`${name}-${scheme}`);
        }
        await current().emulateMedia({ colorScheme: 'dark' });
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
      // A driver/cleanup error is part of the run result, not only its process exit status.
      const passed = !extra.error && results.length > 0 && results.every((result) => result.pass);
      await writeFile(path.join(instance.evidence, file), JSON.stringify({
        issue: instance.issue, label: instance.label ?? null, checkout: instance.checkout,
        commit: instance.commit, dirty: instance.dirty, sourceHash: instance.sourceHash, data: instance.data,
        // The machine the run executed on: platform, OS, Node's and the machine's architecture.
        environment: environment(),
        layer: instance.layer ?? 'Web 模式（headless Chromium）', ...(instance.target ? { target: instance.target } : { url: instance.url }),
        finishedAt: new Date().toISOString(),
        passed, results, shots, ...extra,
      }, null, 2));
      return passed;
    },
  };
}
