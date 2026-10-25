// Browser development mode must explain that login startup belongs to an installed App, and both
// UI and Agent listeners refuse mutation instead of silently registering a development executable.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'login-startup';
export const title = '登入自啟在開發版不可設定';
export const covers = ['login-startup-setting', 'login-startup-unavailable', 'login-startup-os-state'];

export async function run({ instance, page, record, waitFor }) {
  const fixturePath = path.join(instance.runDir, 'login-startup-fixture.json');
  const fixture = async (mode, enabled) => writeFile(fixturePath, JSON.stringify({ mode, enabled }, null, 2));
  const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const switchInput = () => page.getByTestId('login-startup-switch').locator('input');
  const statusText = async () => (await page.getByTestId('login-startup-status').innerText()).trim();
  const visualSwitch = () => page.getByTestId('login-startup-switch').evaluate((label) => {
    const input = label.querySelector('input');
    const track = label.querySelector('.switch');
    return {
      checked: input.checked,
      background: getComputedStyle(track).backgroundColor,
      transform: getComputedStyle(track, '::after').transform,
    };
  });
  const settledVisual = (checked) => waitFor(async () => {
    const visual = await visualSwitch();
    const moved = visual.transform !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/u.test(visual.transform);
    return visual.checked === checked && moved === checked ? visual : null;
  }, `toggle visually ${checked ? 'on' : 'off'}`, { timeout: 3_000 });
  let offBackground = null;

  await record.scenario('W1', 'Web／開發版只說明，不允許註冊登入自啟', async ({ expect, note, shot }) => {
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-login-startup').waitFor();
    await page.getByTestId('login-startup-status').filter({ hasText: '只可在已安裝的 macOS 或 Windows App 中設定' }).waitFor();
    const toggle = switchInput();
    const message = await statusText();
    const disabled = await toggle.isDisabled();
    expect(disabled, '開發版的登入自啟開關停用', { id: 'w1.ui-disabled', expected: true, actual: disabled });
    expect(message.includes('只可在已安裝的 macOS 或 Windows App 中設定'), '畫面說明只能在安裝版設定',
      { id: 'w1.ui-message', expected: '只可在已安裝的 macOS 或 Windows App 中設定', actual: message });
    await shot('settings-unavailable');

    const uiResponse = await fetch(`${instance.url}/api/device/login-startup`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    const ui = { status: uiResponse.status, body: await uiResponse.json() };
    expect(ui.status === 409 && ui.body?.error?.code === 'login_startup_unavailable', 'UI API 拒絕開發版註冊',
      { id: 'w1.ui-api', expected: { status: 409, code: 'login_startup_unavailable' }, actual: ui });

    const connection = JSON.parse(await readFile(path.join(instance.runDir, 'profile', 'agent-connection.json'), 'utf8'));
    const response = await fetch(`${connection.url}/api/device/login-startup`, {
      method: 'PUT', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const body = await response.json();
    note('agent-refusal', { status: response.status, body });
    expect(response.status === 409 && body?.error?.code === 'login_startup_unavailable', 'Agent API 也拒絕開發版註冊',
      { id: 'w1.agent-api', expected: { status: 409, code: 'login_startup_unavailable' }, actual: { status: response.status, body } });
  });

  await record.scenario('W1-F1', '受控平台 fixture：實際切換成功並採用 OS read-back', async ({ expect, note, shot }) => {
    await fixture('normal', false);
    await focus();
    await page.getByTestId('login-startup-status').filter({ hasText: '登入自啟已關閉' }).waitFor();
    expect(!(await switchInput().isDisabled()) && !(await switchInput().isChecked()), 'fixture 可操作且 read-back 為關閉',
      { id: 'w1.fixture-ready', expected: { disabled: false, checked: false }, actual: { disabled: await switchInput().isDisabled(), checked: await switchInput().isChecked() } });
    offBackground = (await settledVisual(false)).background;
    await page.getByTestId('login-startup-switch').click();
    await page.getByTestId('login-startup-status').filter({ hasText: '已在登入電腦時自動啟動' }).waitFor();
    const stored = JSON.parse(await readFile(fixturePath, 'utf8'));
    const visual = await settledVisual(true);
    expect(await switchInput().isChecked() && stored.enabled === true && visual.transform !== 'none' && visual.background !== offBackground, '點開後 DOM、可見開關與平台 read-back 都是開啟',
      { id: 'w1.enable-success', expected: { checked: true, visual: 'right', enabled: true }, actual: { checked: await switchInput().isChecked(), visual, fixture: stored } });
    note('fixture', '此段只驗 UI 與平台 adapter 的串接，不證明真實 OS 已註冊。');
    await shot('settings-enabled-fixture');
  });

  await record.scenario('W1-F2', '受控平台 fixture：寫入失敗後重讀，不樂觀改掉開關', async ({ expect, shot }) => {
    await fixture('failure', true);
    await focus();
    await page.getByTestId('login-startup-status').filter({ hasText: '已在登入電腦時自動啟動' }).waitFor();
    await page.getByTestId('login-startup-switch').click();
    await page.getByTestId('login-startup-status').filter({ hasText: '合成作業系統拒絕更新登入自啟' }).waitFor();
    const visual = await settledVisual(true);
    expect(await switchInput().isChecked(), '關閉寫入失敗後重新讀回，開關仍為 OS 的開啟狀態',
      { id: 'w1.failure-readback', expected: { checked: true, visual: 'right' }, actual: { checked: await switchInput().isChecked(), visual } });
    await shot('settings-failure-fixture');
  });

  await record.scenario('W1-F3', '受控平台 fixture：需要核准與外部停用在 focus 後刷新', async ({ expect, shot }) => {
    await fixture('requires_approval', false);
    await focus();
    await page.getByTestId('login-startup-status').filter({ hasText: '系統設定' }).waitFor();
    expect(!(await switchInput().isChecked()) && (await statusText()).includes('允許 XR Collector'), '需要核准時維持關閉並說明系統設定',
      { id: 'w1.requires-approval', expected: { checked: false, message: '允許 XR Collector' }, actual: { checked: await switchInput().isChecked(), message: await statusText() } });
    await page.getByTestId('login-startup-switch').click();
    await waitFor(async () => {
      const activity = await instance.api('/api/activity?eventType=device.login_startup_failed&limit=10');
      return activity.events.some((event) => event.errorCode === 'login_startup_requires_approval');
    }, 'approval refusal recorded', { timeout: 10_000 });
    await waitFor(async () => (await statusText()).includes('允許 XR Collector'), 'approval message restored after request', { timeout: 10_000 });
    expect(!(await switchInput().isChecked()) && (await statusText()).includes('允許 XR Collector'), '實際點開仍待核准，不把開關顯示成成功',
      { id: 'w1.approval-click', expected: { checked: false, message: '允許 XR Collector' }, actual: { checked: await switchInput().isChecked(), message: await statusText() } });

    await fixture('normal', true);
    await focus();
    await page.getByTestId('login-startup-status').filter({ hasText: '已在登入電腦時自動啟動' }).waitFor();
    const before = await switchInput().isChecked();
    await fixture('normal', false);
    await focus();
    await page.getByTestId('login-startup-status').filter({ hasText: '登入自啟已關閉' }).waitFor();
    const after = await switchInput().isChecked();
    const visual = await settledVisual(false);
    expect(before && !after && visual.background === offBackground, 'OS 外部停用後，視窗 focus 會把開關與可見狀態刷新為關閉',
      { id: 'w1.external-disable', expected: { checked: [true, false], visual: 'left' }, actual: { checked: [before, after], visual } });
    await shot('settings-external-disable-fixture');
  });

  await record.scenario('W1-F4', '受控平台 fixture：較舊的 focus 讀取不得覆蓋較新的切換結果', async ({ expect }) => {
    await fixture('normal', false);
    await focus();
    await page.getByTestId('login-startup-status').filter({ hasText: '登入自啟已關閉' }).waitFor();
    let startSlow;
    const slowStarted = new Promise((resolve) => { startSlow = resolve; });
    let releaseSlow;
    const slowRelease = new Promise((resolve) => { releaseSlow = resolve; });
    let finishSlow;
    const slowFinished = new Promise((resolve) => { finishSlow = resolve; });
    let interceptSlowGet = true;
    const route = async (requestRoute) => {
      const request = requestRoute.request();
      if (interceptSlowGet && request.method() === 'GET') {
        interceptSlowGet = false;
        startSlow();
        await slowRelease;
        try {
          await requestRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            loginStartup: { supported: true, enabled: false, state: 'disabled', message: '登入自啟已關閉。' },
          }) });
        } catch { /* the fixed UI aborts this stale request */ }
        finishSlow();
        return;
      }
      if (request.method() === 'PUT') {
        await requestRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          loginStartup: { supported: true, enabled: true, state: 'enabled', message: '已在登入電腦時自動啟動。' },
        }) });
        return;
      }
      await requestRoute.continue();
    };
    await page.route('**/api/device/login-startup', route);
    try {
      await focus();
      await slowStarted;
      await page.getByTestId('login-startup-switch').click();
      await page.getByTestId('login-startup-status').filter({ hasText: '已在登入電腦時自動啟動' }).waitFor();
      releaseSlow();
      await slowFinished;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const actual = { checked: await switchInput().isChecked(), message: await statusText() };
      expect(actual.checked && actual.message.includes('已在登入電腦時自動啟動'), '較慢的舊 GET 回覆不會蓋掉較新的 PUT read-back', {
        id: 'w1.focus-update-race',
        expected: { checked: true, message: '已在登入電腦時自動啟動' },
        actual,
      });
    } finally {
      releaseSlow();
      await page.unroute('**/api/device/login-startup', route);
    }
  });
}
