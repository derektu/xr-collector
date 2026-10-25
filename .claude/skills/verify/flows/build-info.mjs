import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWeb, openPage } from '../scripts/lib/index.mjs';

export const name = 'build-info';
export const title = '設定與 Onboarding 的建置資訊和 Agent API 一致';
export const covers = ['build-info-settings', 'build-info-onboarding', 'build-info-api'];

async function readInfo(instance) {
  const response = await fetch(`${instance.url}/api/device/build-info`);
  return { status: response.status, body: await response.json() };
}

async function cardMatches(page, info, expect, prefix) {
  const card = page.getByTestId('build-info');
  await card.getByTestId('build-info-version').waitFor();
  const values = {
    version: info.version, time: info.builtAt, commit: info.commit ?? '未知', id: info.buildId,
    target: info.target, kind: info.kind === 'packaged' ? '安裝版' : '開發版',
    variant: info.variant === 'chinese' ? '中文精簡' : info.variant === 'official' ? '官方完整版' : '尚未準備',
  };
  for (const [field, expected] of Object.entries(values)) {
    const actual = (await card.getByTestId(`build-info-${field}`).innerText()).trim();
    expect(actual === expected, `畫面 ${field} 與裝置 API 相同`, { id: `${prefix}.${field}`, expected, actual });
  }
  const text = await card.innerText();
  const sourceMessage = info.sourceDirty === true ? '有未提交修改' : info.sourceDirty === null ? '來源狀態未知' : null;
  expect(sourceMessage ? text.includes(sourceMessage) : !text.includes('有未提交修改') && !text.includes('來源狀態未知'), '來源狀態如實顯示',
    { id: `${prefix}.source`, expected: sourceMessage, actual: text });
}

export async function run({ instance, page, record }) {
  await record.scenario('BINFO-W1', '設定頁與授權 Agent 讀取同一個 build', async ({ expect, themed, shot }) => {
    await page.getByTestId('nav-settings').click();
    const response = await readInfo(instance);
    expect(response.status === 200, '裝置 build API 可讀', { id: 'settings.api', expected: 200, actual: response.status });
    if (response.status !== 200) { await shot('missing-build-info'); return; }
    const info = response.body.buildInfo;
    const pkg = JSON.parse(await readFile(path.join(instance.checkout, 'package.json'), 'utf8'));
    expect(info.version === pkg.version && info.commit === instance.commit && info.kind === 'development', '來源版本與受測 checkout 相同',
      { id: 'settings.source-identity', expected: { version: pkg.version, commit: instance.commit, kind: 'development' },
        actual: { version: info.version, commit: info.commit, kind: info.kind } });
    await cardMatches(page, info, expect, 'settings');
    const connection = JSON.parse(await readFile(path.join(instance.runDir, 'profile', 'agent-connection.json'), 'utf8'));
    const authorized = await fetch(`${connection.url}/api/device/build-info`, { headers: { authorization: `Bearer ${connection.token}` } });
    const agent = await authorized.json();
    expect(authorized.status === 200 && JSON.stringify(agent) === JSON.stringify(response.body), '授權 Agent 與 UI 是同一份身分',
      { id: 'settings.agent', expected: response.body, actual: { status: authorized.status, ...agent } });
    const unauthorized = await fetch(`${connection.url}/api/device/build-info`);
    expect(unauthorized.status === 401, 'Agent API 保留 token 驗證',
      { id: 'settings.auth', expected: 401, actual: unauthorized.status });
    await page.getByTestId('build-info').scrollIntoViewIfNeeded();
    await themed('settings');
    await page.reload();
    await cardMatches(page, info, expect, 'settings-reload');
  });

  await record.scenario('BINFO-W2', '尚未選知識庫也能辨識 build', async ({ expect, shot, note }) => {
    const startup = await launchWeb({ issue: instance.issue, checkout: instance.checkout, vault: 'none', evidence: path.join(instance.evidence, 'onboarding-run') });
    const opened = await openPage(startup);
    try {
      const response = await readInfo(startup);
      const vault = await startup.api('/api/vault/setup');
      expect(response.status === 200 && vault.vault.state === 'not_ready', 'Vault 未就緒時 build API 可讀',
        { id: 'onboarding.api', expected: { status: 200, vault: 'not_ready' }, actual: { status: response.status, vault: vault.vault.state } });
      note('onboarding.source', { commit: startup.commit, dirty: startup.dirty, sourceHash: startup.sourceHash });
      if (response.status !== 200) { await shot('missing-build-info', opened.page); return; }
      await cardMatches(opened.page, response.body.buildInfo, expect, 'onboarding');
      await opened.page.emulateMedia({ colorScheme: 'dark' });
      await shot('onboarding-dark', opened.page);
      await opened.page.emulateMedia({ colorScheme: 'light' });
      await shot('onboarding-light', opened.page);
      note('onboarding.consoleErrors', opened.consoleErrors);
    } finally { await opened.close(); await startup.stop(); }
  });
}
