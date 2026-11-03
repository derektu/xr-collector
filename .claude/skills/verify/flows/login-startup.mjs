// Login startup belongs to the installed App: in a development build the Settings switch is off
// limits, and with a run-local platform fixture a click reaches the platform adapter and the switch
// shows what the platform reads back. Without it a development executable could register itself
// as a login item, or the switch could claim a state the OS never took. The ordering rules (a
// refused write reads again, focus reads again, a stale read never wins) are in
// tests/web/login-startup-control.test.ts; both listeners refusing a development write are in
// tests/server/login-startup-http.test.ts. The Settings page it opens has no notifications section;
// the notification preference is the device API's (tests/server/notifications-http.test.ts).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'login-startup';
export const title = '登入自啟在開發版不可設定，fixture 切換採用 read-back';
export const covers = ['login-startup-setting', 'login-startup-unavailable', 'notification-settings'];

export async function run({ instance, page, record, waitFor }) {
  const fixturePath = path.join(instance.runDir, 'login-startup-fixture.json');
  const fixture = async (mode, enabled) => writeFile(fixturePath, JSON.stringify({ mode, enabled }, null, 2));
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const section = () => page.getByTestId('settings-login-startup');
  const switchInput = () => page.getByTestId('login-startup-switch').locator('input');
  /** The switch as the page shows it: the section's state and the input. */
  const shown = async () => ({
    state: await section().getAttribute('data-state'),
    supported: await section().getAttribute('data-supported'),
    checked: await switchInput().isChecked(),
    disabled: await switchInput().isDisabled(),
  });
  const settled = (state, label) => waitFor(async () => { const now = await shown(); return now.state === state && !now.disabled ? now : null; }, label)
    .catch(() => shown());

  await record.scenario('W1', 'Web／開發版的登入自啟開關停用', async ({ expect, shot }) => {
    await page.getByTestId('nav-settings').click();
    await section().waitFor();
    await waitFor(async () => await section().getAttribute('data-state') === 'unavailable', 'unavailable state read').catch(() => undefined);
    const actual = await shown();
    expect(actual.state === 'unavailable' && actual.supported === 'false' && actual.disabled, '開發版讀到不支援，開關停用',
      { id: 'w1.ui-disabled', expected: { state: 'unavailable', supported: 'false', disabled: true }, actual });
    const notifications = await page.getByTestId('settings-notifications').count();
    expect(notifications === 0, '設定頁沒有通知區塊', { id: 'w1.no-notifications', expected: 0, actual: notifications });
    await shot('settings-unavailable');
  });

  await record.scenario('W1-F1', '受控平台 fixture：實際切換成功並採用 OS read-back', async ({ expect, note, shot }) => {
    await fixture('normal', false);
    await focus();
    const ready = await settled('disabled', 'fixture read back off');
    expect(ready.state === 'disabled' && !ready.checked && !ready.disabled, 'fixture 可操作且 read-back 為關閉',
      { id: 'w1.fixture-ready', expected: { state: 'disabled', checked: false, disabled: false }, actual: ready });
    await page.getByTestId('login-startup-switch').click();
    const on = await settled('enabled', 'switch on after read-back');
    const stored = JSON.parse(await readFile(fixturePath, 'utf8'));
    expect(on.state === 'enabled' && on.checked && stored.enabled === true, '點開後開關與平台 read-back 都是開啟',
      { id: 'w1.enable-success', expected: { state: 'enabled', checked: true, fixture: true }, actual: { ...on, fixture: stored.enabled } });
    note('fixture', '此段只驗 UI 與平台 adapter 的串接，不證明真實 OS 已註冊。');
    await shot('settings-enabled-fixture');
  });
}
