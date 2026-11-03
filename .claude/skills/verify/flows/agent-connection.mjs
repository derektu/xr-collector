// Compact Agent setup, explicit connection export and restart-bound port configuration.
import { readFile } from 'node:fs/promises';
import yauzl from 'yauzl';

export const name = 'agent-connection';
export const title = 'AI 助理連線、Skill 與連線設定';
export const covers = ['agent-connection-summary', 'agent-connection-help', 'agent-connection-export', 'agent-connection-settings'];
export const vault = 'none';

export async function run({ instance, page, record, waitFor }) {
  await record.scenario('A44-W0', '尚未建立知識庫也能使用同一個 AI 助理連線面板', async ({ expect, shot }) => {
    const launcher = page.getByRole('button', { name: 'AI 助理連線', exact: true });
    await launcher.click();
    const panel = page.getByTestId('onboarding-agent-panel');
    await panel.getByTestId('settings-agent-connection').waitFor();
    await panel.getByTestId('agent-active-url').waitFor();
    expect(await panel.getByRole('button', { name: '下載 Skill' }).isEnabled(), 'Not Ready 時可下載 Skill', { id: 'a44.onboarding-download' });
    expect(await panel.getByRole('button', { name: '複製連線資料' }).isEnabled(), 'Not Ready 時可複製連線資料', { id: 'a44.onboarding-copy' });
    expect(await panel.getByRole('button', { name: '連線設定…' }).isEnabled(), 'Not Ready 時可開啟連線設定', { id: 'a44.onboarding-settings' });
    await shot('onboarding-agent-panel');
    await instance.api('/api/vault/setup', { method: 'POST', body: JSON.stringify({ action: 'create', location: instance.runDir, name: 'vault' }) });
    await page.getByTestId('nav-settings').waitFor({ timeout: 10_000 });
  });

  await record.scenario('A44-W1', '設定頁的精簡 AI 助理連線：active 連線與四步說明', async ({ expect, shot }) => {
    await page.getByTestId('nav-settings').click();
    const section = page.getByTestId('settings-agent-connection');
    await section.waitFor();
    const active = (await instance.api('/api/device/agent/connection')).connection.url;
    const shown = (await section.getByTestId('agent-active-url').innerText()).trim();
    expect(shown === active && active.startsWith('http://127.0.0.1:'), '摘要顯示 API 的 active loopback URL', { id: 'a44.active-url', expected: active, actual: shown });
    const help = section.getByRole('button', { name: 'AI 助理連線步驟' });
    await help.click();
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor({ timeout: 5_000 }).catch(() => undefined);
    const steps = await tooltip.locator('li').count();
    expect(steps === 4, '點擊說明顯示四步', { id: 'a44.help', expected: 4, actual: steps });
    await shot('settings-agent-help');
    await page.keyboard.press('Escape');
    const closed = await page.getByRole('tooltip').count();
    expect(closed === 0, 'Escape 收起說明', { id: 'a44.help-escape', expected: 0, actual: closed });
    await shot('settings-agent-compact');
  });

  await record.scenario('A44-W2', '下載與複製只輸出 active 連線', async ({ expect }) => {
    const section = page.getByTestId('settings-agent-connection');
    const download = page.waitForEvent('download');
    await section.getByRole('button', { name: '下載 Skill' }).click();
    const saved = await download;
    expect(saved.suggestedFilename() === 'xr-collector-agent.zip', '下載檔名是 xr-collector-agent.zip', { id: 'a44.download-name', actual: saved.suggestedFilename() });
    const downloaded = await saved.path();
    const files = await zipContents(await readFile(downloaded));
    const bundled = JSON.parse(files.get('xr-collector-agent/connection.json').toString());
    const skill = files.get('xr-collector-agent/SKILL.md').toString();
    const health = await fetch(`${bundled.url}/api/health`, { headers: { authorization: `Bearer ${bundled.token}` } });
    expect([...files.keys()].sort().join(',') === 'xr-collector-agent/SKILL.md,xr-collector-agent/connection.json'
      && health.status === 200 && !('runtimeId' in bundled) && !JSON.stringify(bundled).includes(instance.runDir)
      && skill.includes('`GET /api/health`'), 'ZIP 含通用 Skill 與可用的 active 連線，不含 runtime 或 Vault 定位', {
      id: 'a44.download-content', actual: { entries: [...files.keys()].sort(), health: health.status, runtimeId: 'runtimeId' in bundled, vaultPath: JSON.stringify(bundled).includes(instance.runDir) },
    });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value) => { window.__xrCopiedAgentConnection = value; },
    } }));
    await section.getByRole('button', { name: '複製連線資料' }).click();
    await page.waitForFunction(() => window.__xrCopiedAgentConnection !== undefined, null, { timeout: 5_000 }).catch(() => undefined);
    const copied = JSON.parse(await page.evaluate(() => window.__xrCopiedAgentConnection));
    const exported = (await instance.api('/api/device/agent/connection')).connection;
    expect(copied.url === exported.url && copied.token === exported.token, '剪貼簿與 explicit connection API 相同', { id: 'a44.copy-active', actual: { sameUrl: copied.url === exported.url, sameToken: copied.token === exported.token } });
  });

  await record.scenario('A44-W3', '連線設定延後套用，金鑰重設立即換權限', async ({ expect, shot }) => {
    const section = page.getByTestId('settings-agent-connection');
    const old = (await instance.api('/api/device/agent/connection')).connection;
    await section.getByRole('button', { name: '連線設定…' }).click();
    const dialog = page.locator('dialog.agent-dialog');
    await dialog.getByRole('heading', { name: 'AI 助理連線設定' }).waitFor();
    const fixed = dialog.locator('input[type=radio]').nth(1);
    await fixed.check();
    await dialog.locator('input[type=number]').fill('0');
    await dialog.getByRole('button', { name: '保存設定' }).click();
    const saveAlert = dialog.getByRole('alert');
    await saveAlert.waitFor();
    const saveVisible = await saveAlert.isVisible();
    await shot('agent-dialog-save-error');
    expect(saveVisible, '保存失敗顯示在 modal 內', { id: 'a44.save-error-visible', actual: {
      text: await saveAlert.innerText(), dialogOpen: await dialog.evaluate((element) => element.open),
      dialogVisible: await dialog.isVisible(), alertVisible: saveVisible,
    } });
    await dialog.locator('input[type=number]').fill(String(Number(new URL(old.url).port) + 5));
    await dialog.getByRole('button', { name: '取消' }).click();
    await section.getByRole('button', { name: '連線設定…' }).click();
    expect(await dialog.locator('input[type=radio]').first().isChecked(), '取消後重開會還原已保存的自動模式', { id: 'a44.cancel-restores-draft' });
    await dialog.getByRole('button', { name: '保存設定' }).click();
    expect((await instance.api('/api/device/agent')).agent.configured.mode === 'auto', '取消的 fixed 草稿不會被後續保存', { id: 'a44.cancel-not-saved' });
    await section.getByRole('button', { name: '連線設定…' }).click();
    await fixed.check();
    await dialog.locator('input[type=number]').fill(String(new URL(old.url).port));
    await dialog.getByRole('button', { name: '保存設定' }).click();
    await section.getByTestId('agent-restart-required').waitFor();
    const pending = { shown: (await section.getByTestId('agent-active-url').innerText()).trim(), active: (await instance.api('/api/device/agent/connection')).connection.url };
    expect(pending.shown === old.url && pending.active === old.url, 'pending 設定不熱換 active listener，並提醒重啟', { id: 'a44.pending-active', expected: old.url, actual: pending });
    await section.getByRole('button', { name: '連線設定…' }).click();
    await dialog.getByRole('button', { name: '重設連線金鑰' }).click();
    const confirmation = dialog.getByRole('alertdialog', { name: '確定要重設連線金鑰？' });
    await confirmation.getByRole('button', { name: '取消' }).click();
    const afterCancel = (await instance.api('/api/device/agent/connection')).connection;
    expect(afterCancel.token === old.token, '取消確認不會更換金鑰', { id: 'a44.reset-cancel', actual: { unchanged: afterCancel.token === old.token } });
    const resetEndpoint = '**/api/device/agent/key/reset';
    const failReset = async (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'persistence_failed', message: '測試重設失敗' } }),
    });
    await page.route(resetEndpoint, failReset);
    await dialog.getByRole('button', { name: '重設連線金鑰' }).click();
    await confirmation.getByRole('button', { name: '確認重設' }).click();
    const resetAlert = dialog.getByRole('alert');
    await resetAlert.waitFor();
    expect(await resetAlert.isVisible() && (await resetAlert.innerText()).includes('測試重設失敗'), '重設失敗顯示在 modal 內', {
      id: 'a44.reset-error-visible', actual: { text: await resetAlert.innerText(), dialogVisible: await dialog.isVisible() },
    });
    await page.unroute(resetEndpoint, failReset);
    await confirmation.getByRole('button', { name: '確認重設' }).click();
    const current = await waitFor(async () => {
      const connection = (await instance.api('/api/device/agent/connection')).connection;
      return connection.token !== old.token ? connection : null;
    }, 'connection key reset').catch(async () => (await instance.api('/api/device/agent/connection')).connection);
    const oldHealth = await fetch(`${old.url}/api/health`, { headers: { authorization: `Bearer ${old.token}` } });
    const newHealth = await fetch(`${current.url}/api/health`, { headers: { authorization: `Bearer ${current.token}` } });
    expect(old.token !== current.token && oldHealth.status === 401 && newHealth.status === 200, '重設後舊金鑰 401、新金鑰 200', { id: 'a44.reset-auth', actual: { changed: old.token !== current.token, old: oldHealth.status, current: newHealth.status } });
    await dialog.locator('input[type=radio]').first().check();
    await dialog.getByRole('button', { name: '保存設定' }).click();
  });
}

async function zipContents(bytes) {
  const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true });
  const result = new Map();
  for await (const entry of zip.eachEntry()) {
    const chunks = [];
    for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk);
    result.set(entry.fileName, Buffer.concat(chunks));
  }
  zip.close();
  return result;
}
