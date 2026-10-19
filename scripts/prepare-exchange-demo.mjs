import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MarkdownVault } from '../dist/node/vault/markdown-vault.js';
import { JsonChannelStore } from '../dist/node/channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../dist/node/channels/json-channel-schedule-store.js';
import { writeVaultMarker } from '../dist/node/vault/vault-directory.js';

/**
 * Synthetic Vaults for trying export and import between machines: `home/vault`, the Vault the
 * first machine starts with, and `other/vault`, a Vault created on its own that shares no sync
 * point with it. Export files come from the app itself, so they carry real sync points.
 */
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const root = values.output ? path.resolve(values.output) : path.resolve('.data', 'exchange-demo', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(path.dirname(root), { recursive: true });
// A new destination keeps fixture generation separate from existing validation data.
await mkdir(root);
const home = path.join(root, 'home', 'vault');
const other = path.join(root, 'other', 'vault');
const fixture = {
  channelId: 'UC-demo-home', channelTitle: '合成測試頻道', publishedAt: '2026-09-18T00:00:00.000Z',
  languageCode: 'zh-Hant', languageName: '繁體中文', subtitleKind: 'manual',
};
async function add(vault, videoId, title, bodyMarkdown, channel = {}) {
  await new MarkdownVault(vault).add({ ...fixture, ...channel, videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title, bodyMarkdown });
}
const settings = { intervalMinutes: 60, backfillWindow: '1m', backfillMaxItems: 10 };
const subscription = (id, title) => ({
  id, title, url: `https://www.youtube.com/channel/${id}`, enabled: true, addedAt: '2026-09-18T00:00:00.000Z', settings,
});

for (const vault of [home, other]) {
  await mkdir(vault, { recursive: true });
  await writeVaultMarker(vault, 'XR Collector demo');
}
await add(home, 'demoforest1', '森林觀測紀錄', '這是合成測試資料，搜尋關鍵字：森林觀測。');
await add(home, 'demoocean01', '海洋調查筆記', '海洋調查的合成字幕。');
await add(home, 'demodesert1', '沙漠研究摘要', '沙漠研究的合成字幕。');
await add(home, 'demomount01', '山岳考察', '山岳考察的合成字幕。');
await new JsonChannelStore(home).add(subscription('UC-demo-home', '合成測試頻道'));
await new JsonChannelStore(home).add(subscription('UC-demo-news', '合成新聞頻道'));
await new JsonChannelScheduleStore(home).save({ enabled: true });

await add(other, 'demoforest1', '森林觀測紀錄', '另一份知識庫自己整理的森林觀測內容。');
await add(other, 'demoorchid1', '蘭花研究', 'Orchid research from the other Vault.');
await new JsonChannelStore(other).add({ ...subscription('UC-demo-home', '合成測試頻道'), settings: { ...settings, intervalMinutes: 180 } });
await new JsonChannelScheduleStore(other).save({ enabled: true });

console.log(`合成資料：${root}\nhome/vault 是第一台電腦的知識庫；other/vault 是另外建立、沒有共同同步點的知識庫。`);
