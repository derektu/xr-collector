// The menu bar item (macOS) or notification area icon (Windows) and the window's lifecycle, in the
// development Electron: the menu while idle, closing the window while collection and the Agent API
// go on, checking and switching automatic checks from the menu, the menu following changes made
// elsewhere without reading while idle, opening pages from it, the first-close hint once per device,
// a second launch, and quitting from the menu in the middle of a check. The menu is read as the
// tray draws it, by icon, action and check mark; its wording is in tests/electron/tray-menu.test.ts.
// With the window hidden, showing and hiding are judged by the app's own record; with --visible
// the window on screen must agree. The flow serves its own RSS feed on the run's feeds port and
// holds its answer to keep a check running for as long as a scenario needs.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { clickTray, closeWindow, notifications, shownIn, trayMenu, trayShown, windowState } from '../scripts/lib/electron.mjs';
import { processTable, programName, WINDOWS } from '../scripts/lib/platform.mjs';

export const name = 'tray';
export const title = '選單列／系統匣與視窗生命週期';
export const covers = ['tray-menu', 'tray-hide', 'tray-actions', 'tray-open', 'tray-hint', 'tray-second-launch', 'tray-quit'];
export const desktop = true;
export const visibleScenarios = ['TRAY-D2', 'TRAY-D5', 'TRAY-D6', 'TRAY-D7'];

/** The idle period watched for reads: long enough to catch reading on a timer, which happened every 2 s or faster. */
const IDLE_MS = 10_000;
const ACTIONS = ['open', 'check_now', 'toggle_auto_check', 'jobs', 'activity', 'check_app_update', 'quit'];
const actions = (menu) => menu.items.filter((item) => item.kind === 'action').map((item) => item.action);
const autoCheck = (menu) => menu.items.find((item) => item.action === 'toggle_auto_check')?.checked;

/**
 * An RSS feed whose articles the flow adds. `hold()` keeps every request waiting until `release()`;
 * `waiting` counts the requests held now.
 */
async function serveFeed(port) {
  const feed = { articles: [] };
  let gate = null;
  let waiting = 0;
  const xml = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>【合成】選單列測試</title><link>http://127.0.0.1:${port}/</link>${
    feed.articles.map((article) => `<item><title>${article.title}</title><link>http://127.0.0.1:${port}/a/${article.id}</link><guid>tray-${article.id}</guid><pubDate>${article.published.toUTCString()}</pubDate><description>${article.title} 的內容。</description></item>`).join('')
  }</channel></rss>`;
  const server = createServer(async (request, response) => {
    if (gate) {
      waiting += 1;
      await gate.promise;
      waiting -= 1;
    }
    if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' }).end(xml());
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}/feed.xml`,
    add(count) {
      for (let index = 0; index < count; index += 1) {
        const id = feed.articles.length + 1;
        feed.articles.push({ id, title: `【合成】選單列文章 ${id}`, published: new Date(Date.now() - 60_000) });
      }
    },
    hold() { if (!gate) { let open; gate = { promise: new Promise((resolve) => { open = resolve; }) }; gate.open = open; } },
    release() { gate?.open(); gate = null; },
    get waiting() { return waiting; },
    close: () => new Promise((resolve) => { gate?.open(); server.closeAllConnections(); server.close(resolve); }),
  };
}

export async function run({ instance, record, waitFor, sleep, visible }) {
  const feed = await serveFeed(instance.ports.feeds);
  const documentsTotal = async () => (await instance.api('/api/documents?limit=1')).total;
  const idle = async () => {
    const overview = (await instance.api('/api/jobs/overview')).overview;
    return overview.running.length === 0 && overview.queued.length === 0;
  };
  const menu = () => trayMenu(instance.app);
  /** Whether the window reads as shown; see shownIn. */
  const shown = async () => shownIn(await windowState(instance.app), visible);
  const instanceId = async () => (await instance.api('/api/health')).runtime?.instanceId;
  /** The Agent API's view of the runtime, through the connection file an Agent reads. */
  const agentHealth = async () => {
    const connection = (await instance.api('/api/device/agent/connection')).connection;
    const response = await fetch(`${connection.url}/api/health`, { headers: { authorization: `Bearer ${connection.token}` } });
    return response.ok ? (await response.json()).runtime?.instanceId ?? null : `HTTP ${response.status}`;
  };
  /** A scenario whose checks name what they saw; each check's ID is the scenario's with a number. */
  const scenario = (id, heading, body) => record.scenario(id, heading, async ({ expect, ...rest }) => {
    let count = 0;
    try {
      await body({ ...rest, expect: (ok, text, actual) => expect(ok, text, { id: `${id}-${++count}`, expected: text, actual }) });
    } catch (error) {
      console.log(error.stack);
      throw error;
    }
  });
  /** The menu's states while `until` is false, for a status sequence. */
  const sample = async (until, timeout) => {
    const seen = [];
    await waitFor(async () => {
      const current = await menu();
      const key = JSON.stringify({ icon: current.icon });
      if (seen.at(-1) !== key) seen.push(key);
      return until();
    }, 'the menu sampled until the condition', { timeout, interval: 250 });
    return seen.map((entry) => JSON.parse(entry));
  };

  try {
    feed.add(3);
    await instance.api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ url: feed.url }) });
    await waitFor(async () => await idle() && await documentsTotal() === 3, 'subscribed feed collected');
    const firstId = await instanceId();

    await scenario('TRAY-D1', '閒置時的選單', async ({ expect, note, shot }) => {
      const current = await menu();
      note('menu', current);
      expect(current.icon === 'idle', '圖示為閒置', current.icon);
      expect(JSON.stringify(actions(current)) === JSON.stringify(ACTIONS), '項目依序為開啟、立即檢查、自動檢查、工作、記錄、檢查 App 更新、結束', actions(current));
      expect(autoCheck(current) === true, '自動檢查已勾選', autoCheck(current));
      await waitFor(async () => await instance.window.getByTestId('subscription-status').first().getAttribute('data-phase') === 'scheduled',
        'source row shows its scheduled state');
      await shot('window');
    });

    await scenario('TRAY-D2', '關閉視窗：隱藏、程序與 Agent API 照常', async ({ expect, note }) => {
      await instance.window.evaluate(() => { window.__trayFlowMarker = 'before-close'; });
      await closeWindow(instance.app);
      await waitFor(async () => await shown() === false, 'window hidden').catch(() => undefined);
      const state = await windowState(instance.app);
      note('window', state);
      expect(state.exists && shownIn(state, visible) === false, '視窗隱藏但沒有銷毀', state);
      expect(instance.app.process().exitCode === null, '程序還在', instance.app.process().exitCode);
      const agent = await agentHealth();
      expect(agent === firstId, 'Agent API /api/health 照常回應，instanceId 不變', { agent, firstId });
      const sent = await notifications(instance.app);
      note('notifications', sent);
      if (WINDOWS) expect(sent.length === 1, 'Windows 發出一次「仍在系統匣執行」通知', sent);
      else expect(sent.length === 0, 'macOS 不發通知', sent);
    });

    await scenario('TRAY-D3', '視窗隱藏時從選單立即檢查', async ({ expect, note }) => {
      feed.add(2);
      feed.hold();
      await clickTray(instance.app, 'check_now');
      // The check stays on the held feed until the menu has been read.
      const running = await sample(async () => feed.waiting > 0 && (await menu()).icon === 'collecting', 60_000).catch(() => null);
      expect(running !== null, '檢查時圖示為收集中', running ?? await menu());
      feed.release();
      const sequence = await sample(async () => await documentsTotal() === 5 && await idle(), 60_000);
      const settled = await sample(async () => (await menu()).icon === 'idle', 10_000);
      note('sequence', [...(running ?? []), ...sequence, ...settled]);
      const last = await menu();
      expect(last.icon === 'idle' && await idle(), '檢查結束後回到閒置', last.icon);
      expect(await documentsTotal() === 5, '文件由 3 份變成 5 份', await documentsTotal());
      const state = await windowState(instance.app);
      expect(shownIn(state, visible) === false, '整個檢查期間視窗維持隱藏', state);
    });

    await scenario('TRAY-D4', '從選單關閉與開啟自動檢查', async ({ expect, note }) => {
      await clickTray(instance.app, 'toggle_auto_check');
      await waitFor(async () => (await instance.api('/api/schedule')).schedule.enabled === false, 'automatic checks off');
      const off = await menu();
      note('off', off);
      expect(off.icon === 'auto_check_off' && autoCheck(off) === false, '關閉後圖示與勾選都反映自動檢查已關閉', off);
      await clickTray(instance.app, 'toggle_auto_check');
      await waitFor(async () => (await instance.api('/api/schedule')).schedule.enabled === true, 'automatic checks on');
      const on = await menu();
      const next = (await instance.api('/api/schedule')).schedule.nextCheck;
      expect(on.icon === 'idle' && autoCheck(on) === true && Boolean(next), '再開啟後恢復閒置，排定下次檢查', { icon: on.icon, checked: autoCheck(on), next });
    });

    await scenario('TRAY-D9', '選單跟著別處的變動更新，閒置時不讀', async ({ expect, note }) => {
      const drawn = () => trayShown(instance.app);
      // The reads the previous scenario's changes started end first; the idle period starts after them.
      const before = await waitFor(async () => { const shown = await drawn(); return shown.reading ? null : shown; }, 'the tray finished reading');
      await sleep(IDLE_MS);
      const after = await drawn();
      note('idleReads', { before: before.reads, after: after.reads });
      expect(Number.isInteger(before.reads) && after.reads === before.reads, `閒置 ${IDLE_MS / 1000} 秒，選單沒有讀取狀態`, { before: before.reads, after: after.reads });
      await instance.api('/api/schedule', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
      await waitFor(async () => (await drawn()).menu.icon === 'auto_check_off', 'the drawn menu shows automatic checks off');
      expect(autoCheck((await drawn()).menu) === false, '經 API 關閉自動檢查後，畫出的選單自己更新', (await drawn()).menu.icon);
      await instance.api('/api/schedule', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
      await waitFor(async () => (await drawn()).menu.icon === 'idle', 'the drawn menu shows automatic checks on');
      const total = await documentsTotal();
      feed.add(1);
      feed.hold();
      const icons = [];
      const follow = async (until) => {
        const icon = (await drawn()).menu.icon;
        if (icons.at(-1) !== icon) icons.push(icon);
        return until(icon);
      };
      try {
        await instance.api('/api/subscription-checks', { method: 'POST', body: '{}' });
        // The check waits on the held feed until the drawn menu shows it collecting.
        await waitFor(() => follow((icon) => feed.waiting > 0 && icon === 'collecting'), 'the drawn menu shows the check start', { interval: 100 }).catch(() => undefined);
      } finally {
        feed.release();
      }
      await waitFor(() => follow((icon) => icons.includes('collecting') && icon === 'idle'), 'the drawn menu shows the check end', { interval: 100 }).catch(() => undefined);
      note('icons', icons);
      expect(icons.includes('collecting') && icons.at(-1) === 'idle', '經 API 開始的檢查，畫出的選單顯示收集中再回到閒置', icons);
      await waitFor(async () => await documentsTotal() === total + 1 && await idle(), 'the check collected one document');
    });

    await scenario('TRAY-D5', '從選單開啟工作、記錄與主視窗', async ({ expect, note, shot }) => {
      const opened = async (action, pathname) => {
        await clickTray(instance.app, action);
        await waitFor(async () => {
          const state = await windowState(instance.app);
          return shownIn(state, visible) === true && new URL(state.url).pathname === pathname;
        }, `${action} shows ${pathname}`).catch(() => undefined);
        const state = await windowState(instance.app);
        note(action, state);
        return state;
      };
      const jobs = await opened('jobs', '/jobs');
      await instance.window.getByTestId('page-jobs').waitFor();
      expect(shownIn(jobs, visible) === true && new URL(jobs.url).pathname === '/jobs', '「工作」顯示視窗並在 /jobs', jobs);
      await shot('jobs');
      await closeWindow(instance.app);
      const activity = await opened('activity', '/activity');
      expect(shownIn(activity, visible) === true && new URL(activity.url).pathname === '/activity', '「記錄」顯示視窗並在 /activity', activity);
      await shot('activity');
      await closeWindow(instance.app);
      await waitFor(async () => await shown() === false, 'window hidden');
      await clickTray(instance.app, 'open');
      await waitFor(async () => await shown() === true, 'open shows the window').catch(() => undefined);
      expect(await shown() === true, '「開啟」顯示視窗', await windowState(instance.app));
      const marker = await instance.window.evaluate(() => window.__trayFlowMarker ?? null);
      expect(marker === 'before-close', '重新開啟沒有重新載入頁面', marker);
      expect(await instanceId() === firstId, '同一個 runtime（instanceId 不變）', await instanceId());
      const focused = (await windowState(instance.app)).focused;
      note('focusedAfterOpen', focused);
    });

    await scenario('TRAY-D6', '第一次關閉提示只出現一次', async ({ expect, note }) => {
      await closeWindow(instance.app);
      await waitFor(async () => await shown() === false, 'window hidden');
      const again = await notifications(instance.app);
      expect(again.length === (WINDOWS ? 1 : 0), '再關一次不再發通知', again);
      await instance.relaunch();
      await closeWindow(instance.app);
      await waitFor(async () => await shown() === false, 'window hidden after relaunch');
      const afterRestart = await notifications(instance.app);
      note('afterRestart', afterRestart);
      expect(afterRestart.length === 0, '重新啟動後關閉也不發通知', afterRestart);
      const recorded = (() => { try { return JSON.parse(readFileSync(path.join(instance.profile, 'tray.json'), 'utf8')); } catch { return null; } })();
      note('tray.json', recorded);
      if (WINDOWS) expect(recorded?.closeHintShown === true, 'profile 記錄已提示過', recorded);
    });

    await scenario('TRAY-D7', '視窗隱藏時再啟動一次', async ({ expect, note }) => {
      const beforeSecondLaunch = await instanceId();
      const code = await instance.launchAgain();
      note('secondExit', code);
      expect(code === 0, '第二次啟動交給執行中的 App 後結束', code);
      await waitFor(async () => await shown() === true, 'the running window shows').catch(() => undefined);
      expect(await shown() === true, '原本的視窗顯示出來', await windowState(instance.app));
      expect(await instanceId() === beforeSecondLaunch, '手動第二次啟動不建立第二個 runtime', await instanceId());
    });

    await scenario('TRAY-D8', '檢查中從選單結束，再啟動接續', async ({ expect, note }) => {
      const total = await documentsTotal();
      feed.add(2);
      feed.hold();
      await clickTray(instance.app, 'check_now');
      await waitFor(async () => feed.waiting > 0 && (await menu()).icon === 'collecting', 'a check runs on the held feed');
      // The check is held at the feed, so quitting interrupts it before it saves anything.
      const beforeQuit = { icon: (await menu()).icon, documents: await documentsTotal(), waiting: feed.waiting };
      note('beforeQuit', beforeQuit);
      expect(beforeQuit.documents === total && beforeQuit.waiting > 0, '結束時檢查還在進行，文件還沒增加', beforeQuit);
      await clickTray(instance.app, 'quit');
      await instance.exited();
      const searchProcesses = () => processTable().filter((entry) => programName(entry.executable ?? '') === 'meilisearch' && entry.command.includes(instance.runDir));
      // The app stops Meilisearch before it exits; the bound only lets the process table catch up.
      await waitFor(() => searchProcesses().length === 0, 'Meilisearch ends with the app', { timeout: 3_000 }).catch(() => undefined);
      const search = searchProcesses();
      expect(search.length === 0, '程序結束，Meilisearch 也結束', search.map((entry) => entry.pid));
      feed.release();
      await instance.relaunch();
      await waitFor(async () => await documentsTotal() === total + 2 && await idle(), 'the interrupted check finishes after relaunch', { timeout: 90_000 });
      expect(await documentsTotal() === total + 2, `重啟後接續的檢查完成，文件由 ${total} 份變成 ${total + 2} 份`, await documentsTotal());
    });
  } finally {
    await feed.close();
  }
}
