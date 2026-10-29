// Device notification preference, shared UI/Agent contract, persistence, and current-Vault
// actionable rows. Native delivery/click behavior remains in the Desktop tray acceptance.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { idle, subscribe } from '../scripts/lib/index.mjs';

export const name = 'notifications';
export const title = '訂閱自動暫停通知設定與裝置事件';
export const tier = 'feature';
export const covers = ['notification-settings', 'notification-actionable'];

export async function run({ instance, page, record, waitFor }) {
  await record.scenario('NOTIFY-W1', '設定無規格說明區塊，內部通知參數仍供授權 Agent 使用', async ({ expect, themed }) => {
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-search-index').waitFor();
    const sections = await page.getByTestId('settings-notifications').count();
    expect(sections === 0, '設定頁不提供通知區塊', { id: 'settings.no-section', expected: 0, actual: sections });
    for (const text of ['索引由知識庫文件產生，重建不會改動文件。', '開啟後，登入電腦時會在背景啟動 XR Collector，繼續排程與 Agent 服務，但不會自動顯示主視窗。', '請安裝並開啟打包後的 App，再回到這裡設定。']) {
      const count = await page.getByText(text, { exact: true }).count();
      expect(count === 0, `設定頁移除補充文字：${text}`, { expected: 0, actual: count });
    }
    const ui = await instance.api('/api/device/notifications');
    expect(ui.notifications.enabled === true, '內部通知參數預設開啟', { id: 'settings.default', expected: true, actual: ui.notifications.enabled });
    const { connection } = await instance.api('/api/device/agent/connection');
    const agentResponse = await fetch(`${connection.url}/api/device/notifications`, { headers: { authorization: `Bearer ${connection.token}` } });
    const agent = await agentResponse.json();
    expect(agentResponse.status === 200 && JSON.stringify(agent.notifications) === JSON.stringify(ui.notifications), 'UI／授權 Agent 讀同一份通知狀態',
      { id: 'settings.shared-api', expected: ui.notifications, actual: { status: agentResponse.status, notifications: agent.notifications } });
    expect(ui.notifications.availability === 'unavailable', '裝置 API 保留通知診斷',
      { id: 'settings.availability', expected: 'unavailable', actual: ui.notifications.availability });
    await page.getByTestId('settings-login-startup').scrollIntoViewIfNeeded();
    await themed('settings-surface');
  });

  await record.scenario('NOTIFY-W2', '關閉偏好持久，重新開啟不補發關閉期間事件', async ({ expect, note }) => {
    await instance.api('/api/device/notifications', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    await waitFor(async () => !(await instance.api('/api/device/notifications')).notifications.enabled, 'notification preference off');
    await instance.restart({ page });
    const afterRestart = await instance.api('/api/device/notifications');
    expect(afterRestart.notifications.enabled === false, '重啟後通知仍關閉', { id: 'preference.restart', expected: false, actual: afterRestart.notifications.enabled });

    const catalog = await instance.catalog();
    const channel = catalog.youtube.channels.find((candidate) => candidate.handle === 'verify-a');
    await subscribe(instance, `https://www.youtube.com/@${channel.handle}`);
    await idle(instance);
    const filePath = path.join(instance.runDir, 'vault', 'settings', 'youtube-channels.json');
    const file = JSON.parse(await readFile(filePath, 'utf8'));
    const row = file.channels.find((candidate) => candidate.id === channel.id);
    row.enabled = false;
    row.nextCheckAt = null;
    row.autoPausedAt = new Date().toISOString();
    row.checkFailures = { count: 5, since: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), error: { code: 'network_error', message: '合成的最後錯誤' } };
    await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
    await instance.restart({ page });
    const suppressed = await instance.api('/api/device/notifications');
    note('suppressed', suppressed.notifications);
    expect(suppressed.notifications.active.length === 1 && suppressed.notifications.active[0].delivery === 'suppressed' && suppressed.notifications.events.length === 0,
      '目前 Vault 的既有自動暫停出現在 active，但不補發或製造 ledger', { id: 'preference.no-backlog', expected: { active: 1, delivery: 'suppressed', events: 0 }, actual: suppressed.notifications });
    await instance.api('/api/device/notifications', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    const enabled = await instance.api('/api/device/notifications');
    expect(enabled.notifications.enabled && enabled.notifications.events.length === 0, '重新開啟不補發累積通知',
      { id: 'preference.reenable', expected: { enabled: true, events: 0 }, actual: enabled.notifications });
  });
}
