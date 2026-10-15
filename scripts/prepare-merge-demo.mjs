import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MarkdownVault } from '../dist/node/vault/markdown-vault.js';
import { JsonChannelStore } from '../dist/node/channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../dist/node/channels/json-channel-schedule-store.js';
import { exportVault } from '../dist/node/vault/vault-package.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const root = values.output ? path.resolve(values.output) : path.resolve('.data', 'merge-demo', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(path.dirname(root), { recursive: true });
// A new destination keeps fixture generation separate from existing validation data.
await mkdir(root);
const local = path.join(root, 'profile', 'vault'); const incoming = path.join(root, 'incoming');
const fixture = { videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', title: '差異文件：森林或海洋',
  channelId: 'UC-demo', channelTitle: '合成測試頻道', publishedAt: null, languageCode: 'zh-Hant', languageName: '中文', subtitleKind: 'manual' };
async function add(destination, id, title, bodyMarkdown) {
  await new MarkdownVault(destination).add({ ...fixture, videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}`, title, bodyMarkdown });
}
await add(local, 'abcdefghijk', fixture.title, '共同的第一段。\n\n本機版本：森林觀測。\n\n共同的最後一段。');
await add(incoming, 'abcdefghijk', fixture.title, '共同的第一段。\n\n匯入版本：海洋調查。\n\n共同的最後一段。');
for (const target of [local, incoming]) await add(target, 'same0000001', '相同文件', '相同內容應跳過。');
await add(local, 'localonly01', '只在本機', '來源缺少這份文件，合併後仍保留。山岳考察。');
await add(incoming, 'new00000001', '新增文件', '新增沙漠研究。');
const channel = { id: 'UC-demo', title: '合成測試頻道', url: 'https://www.youtube.com/channel/UC-demo', enabled: true, addedAt: '2026-09-18T00:00:00.000Z' };
await new JsonChannelStore(local).add(channel);
await new JsonChannelStore(incoming).add({ ...channel, title: '匯入頻道名稱', enabled: false });
await new JsonChannelStore(incoming).add({ ...channel, id: 'UC-new', title: '新增頻道', url: 'https://www.youtube.com/channel/UC-new', enabled: false });
for (const [target, intervalMinutes] of [[local, 60], [incoming, 180]]) {
  await new JsonChannelScheduleStore(target).save({ enabled: false, intervalMinutes, nextRunAt: null, lastAttemptAt: null, lastCompletedAt: null, lastResult: null });
  await mkdir(path.join(target, 'attachments'), { recursive: true });
  await writeFile(path.join(target, 'attachments', 'sample.bin'), Buffer.from([0, 128, intervalMinutes]));
}
await writeFile(path.join(root, 'incoming.xr-vault'), await exportVault(incoming));
await writeFile(path.join(root, 'local-before.xr-vault'), await exportVault(local));
console.log(`合成資料：${root}\n在 validation 工作區還原 local-before.xr-vault，再選 incoming.xr-vault 比對合併。`);
