// The menu bar item (macOS) or notification area icon (Windows) and the window's lifecycle, in the
// development Electron with its window shown: the menu while idle, closing the window while
// collection and the Agent API go on, checking and switching automatic checks from the menu,
// opening pages from it, the first-close hint once per device, a second launch, and quitting from
// the menu in the middle of a check. The flow serves its own RSS feed on the run's feeds port.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { clickTray, closeWindow, notifications, trayMenu, windowState } from '../scripts/lib/electron.mjs';
import { processTable, programName, WINDOWS } from '../scripts/lib/platform.mjs';

export const name = 'tray';
export const title = '選單列／系統匣與視窗生命週期';
export const tier = 'platform';
export const covers = ['tray-menu', 'tray-hide', 'tray-actions', 'tray-open', 'tray-hint', 'tray-second-launch', 'tray-quit'];
export const desktop = true;

const ACTIONS = ['開啟 XR Collector', '立即檢查所有訂閱', '自動檢查', '工作', '記錄', '結束 XR Collector'];
const statusLines = (menu) => menu.items.filter((item) => item.kind === 'status').map((item) => item.label);
const actionLabels = (menu) => menu.items.filter((item) => item.kind === 'action').map((item) => item.label);
const autoCheck = (menu) => menu.items.find((item) => item.action === 'toggle_auto_check')?.checked;

/** An RSS feed whose articles the flow adds, answering after `delayMs`. */
async function serveFeed(port) {
  const feed = { articles: [], delayMs: 0 };
  const xml = () => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>【合成】選單列測試</title><link>http://127.0.0.1:${port}/</link>${
    feed.articles.map((article) => `<item><title>${article.title}</title><link>http://127.0.0.1:${port}/a/${article.id}</link><guid>tray-${article.id}</guid><pubDate>${article.published.toUTCString()}</pubDate><description>${article.title} 的內容。</description></item>`).join('')
  }</channel></rss>`;
  const server = createServer((request, response) => {
    const answer = () => response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' }).end(xml());
    if (feed.delayMs) setTimeout(answer, feed.delayMs); else answer();
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
    set delay(ms) { feed.delayMs = ms; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

export async function run({ instance, record, waitFor, sleep }) {
  const feed = await serveFeed(instance.ports.feeds);
  const documentsTotal = async () => (await instance.api('/api/documents?limit=1')).total;
  const idle = async () => {
    const overview = (await instance.api('/api/jobs/overview')).overview;
    return overview.running.length === 0 && overview.queued.length === 0;
  };
  const menu = () => trayMenu(instance.app);
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
      const key = JSON.stringify({ icon: current.icon, status: statusLines(current) });
      if (seen.at(-1) !== key) seen.push(key);
      return until();
    }, 'the menu sampled until the condition', { timeout, interval: 250 });
    return seen.map((entry) => JSON.parse(entry));
  };

  try {
    feed.add(3);
    await instance.api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ url: feed.url }) });
    await waitFor(async () => await idle() && await documentsTotal() === 3, 'subscribed feed collected', { timeout: 60_000 });
    const firstId = await instanceId();

    await scenario('TRAY-D1', '閒置時的選單', async ({ expect, note, shot }) => {
      const current = await menu();
      note('menu', current);
      expect(current.icon === 'idle', '圖示為閒置', current.icon);
      const lines = statusLines(current);
      expect(lines[0] === '沒有進行中的工作' && /^下次檢查 (明天 )?\d\d:\d\d$/u.test(lines[1] ?? '') && lines.length === 2, '狀態行為「沒有進行中的工作／下次檢查 HH:MM」', lines);
      expect(JSON.stringify(actionLabels(current)) === JSON.stringify(ACTIONS), '項目依序為開啟、立即檢查、自動檢查、工作、記錄、結束', actionLabels(current));
      expect(autoCheck(current) === true, '自動檢查已勾選', autoCheck(current));
      await waitFor(async () => /^下次 /u.test((await instance.window.getByTestId('subscription-status').first().innerText()).trim()),
        'source row shows its scheduled state', { timeout: 10_000 });
      await shot('window');
    });

    await scenario('TRAY-D2', '關閉視窗：隱藏、程序與 Agent API 照常', async ({ expect, note }) => {
      await instance.window.evaluate(() => { window.__trayFlowMarker = 'before-close'; });
      await closeWindow(instance.app);
      await waitFor(async () => !(await windowState(instance.app)).visible, 'window hidden', { timeout: 10_000 });
      const state = await windowState(instance.app);
      note('window', state);
      expect(state.exists && !state.visible, '視窗隱藏但沒有銷毀', state);
      expect(instance.app.process().exitCode === null, '程序還在', instance.app.process().exitCode);
      const agent = await agentHealth();
      expect(agent === firstId, 'Agent API /api/health 照常回應，instanceId 不變', { agent, firstId });
      const shown = await notifications(instance.app);
      note('notifications', shown);
      if (WINDOWS) expect(shown.length === 1 && shown[0].title === 'XR Collector 仍在系統匣執行', 'Windows 發出一次「仍在系統匣執行」通知', shown);
      else expect(shown.length === 0, 'macOS 不發通知', shown);
    });

    await scenario('TRAY-D3', '視窗隱藏時從選單立即檢查', async ({ expect, note }) => {
      feed.add(2);
      feed.delay = 4000;
      await clickTray(instance.app, 'check_now');
      const sequence = await sample(async () => await documentsTotal() === 5 && await idle(), 60_000);
      const settled = await sample(async () => (await menu()).icon === 'idle', 10_000);
      note('sequence', [...sequence, ...settled]);
      const busy = sequence.filter((entry) => entry.icon === 'collecting');
      expect(busy.length > 0 && busy.every((entry) => entry.status.some((line) => /^(正在檢查|正在收集|排隊中)/u.test(line))), '檢查時圖示為收集中，狀態行為正在檢查／正在收集／排隊中', busy);
      const last = await menu();
      expect(last.icon === 'idle' && statusLines(last)[0] === '沒有進行中的工作', '檢查結束後回到閒置', statusLines(last));
      expect(await documentsTotal() === 5, '文件由 3 份變成 5 份', await documentsTotal());
      expect(!(await windowState(instance.app)).visible, '整個檢查期間視窗維持隱藏', await windowState(instance.app));
      feed.delay = 0;
    });

    await scenario('TRAY-D4', '從選單關閉與開啟自動檢查', async ({ expect, note }) => {
      await clickTray(instance.app, 'toggle_auto_check');
      await waitFor(async () => (await instance.api('/api/schedule')).schedule.enabled === false, 'automatic checks off', { timeout: 10_000 });
      const off = await menu();
      note('off', off);
      expect(off.icon === 'auto_check_off' && statusLines(off).includes('自動檢查已關閉') && autoCheck(off) === false, '關閉後圖示、第二行與勾選都反映自動檢查已關閉', off);
      await clickTray(instance.app, 'toggle_auto_check');
      await waitFor(async () => (await instance.api('/api/schedule')).schedule.enabled === true, 'automatic checks on', { timeout: 10_000 });
      const on = await menu();
      expect(on.icon === 'idle' && autoCheck(on) === true && /^下次檢查/u.test(statusLines(on)[1] ?? ''), '再開啟後恢復閒置與下次檢查', on);
    });

    await scenario('TRAY-D5', '從選單開啟工作、記錄與主視窗', async ({ expect, note, shot }) => {
      const opened = async (action, pathname) => {
        await clickTray(instance.app, action);
        await waitFor(async () => {
          const state = await windowState(instance.app);
          return state.visible && new URL(state.url).pathname === pathname;
        }, `${action} shows ${pathname}`, { timeout: 10_000 });
        const state = await windowState(instance.app);
        note(action, state);
        return state;
      };
      const jobs = await opened('jobs', '/jobs');
      await instance.window.getByTestId('page-jobs').waitFor({ timeout: 10_000 });
      expect(jobs.visible, '「工作」顯示視窗並在 /jobs', jobs);
      await shot('jobs');
      await closeWindow(instance.app);
      const activity = await opened('activity', '/activity');
      expect(activity.visible, '「記錄」顯示視窗並在 /activity', activity);
      await shot('activity');
      await closeWindow(instance.app);
      await waitFor(async () => !(await windowState(instance.app)).visible, 'window hidden', { timeout: 10_000 });
      await clickTray(instance.app, 'open');
      await waitFor(async () => (await windowState(instance.app)).visible, 'open shows the window', { timeout: 10_000 });
      const marker = await instance.window.evaluate(() => window.__trayFlowMarker ?? null);
      expect(marker === 'before-close', '重新開啟沒有重新載入頁面', marker);
      expect(await instanceId() === firstId, '同一個 runtime（instanceId 不變）', await instanceId());
      const focused = (await windowState(instance.app)).focused;
      note('focusedAfterOpen', focused);
    });

    await scenario('TRAY-D6', '第一次關閉提示只出現一次', async ({ expect, note }) => {
      await closeWindow(instance.app);
      await waitFor(async () => !(await windowState(instance.app)).visible, 'window hidden', { timeout: 10_000 });
      const again = await notifications(instance.app);
      expect(again.length === (WINDOWS ? 1 : 0), '再關一次不再發通知', again);
      await instance.relaunch();
      await closeWindow(instance.app);
      await waitFor(async () => !(await windowState(instance.app)).visible, 'window hidden after relaunch', { timeout: 10_000 });
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
      await waitFor(async () => (await windowState(instance.app)).visible, 'the running window shows', { timeout: 10_000 });
      expect((await windowState(instance.app)).visible, '原本的視窗顯示出來', await windowState(instance.app));
      expect(await instanceId() === beforeSecondLaunch, '手動第二次啟動不建立第二個 runtime', await instanceId());
    });

    await scenario('TRAY-D8', '檢查中從選單結束，再啟動接續', async ({ expect, note }) => {
      feed.add(2);
      feed.delay = 8000;
      await clickTray(instance.app, 'check_now');
      await waitFor(async () => (await menu()).icon === 'collecting', 'a check runs', { timeout: 10_000 });
      note('beforeQuit', await menu());
      await clickTray(instance.app, 'quit');
      await instance.exited();
      await sleep(1000);
      const search = processTable().filter((entry) => programName(entry.executable ?? '') === 'meilisearch' && entry.command.includes(instance.runDir));
      expect(search.length === 0, '程序結束，Meilisearch 也結束', search.map((entry) => entry.pid));
      feed.delay = 0;
      await instance.relaunch();
      await waitFor(async () => await documentsTotal() === 7 && await idle(), 'the interrupted check finishes after relaunch', { timeout: 90_000 });
      expect(await documentsTotal() === 7, '重啟後接續的檢查完成，文件由 5 份變成 7 份', await documentsTotal());
    });
  } finally {
    await feed.close();
  }
}
