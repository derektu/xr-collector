import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { exportVault } from '../dist/node/vault/vault-package.js';
import { MarkdownVault } from '../dist/node/vault/markdown-vault.js';
import { JsonChannelStore } from '../dist/node/channels/json-channel-store.js';
import { JsonChannelScheduleStore } from '../dist/node/channels/json-channel-schedule-store.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const root = values.output ? path.resolve(values.output) : path.resolve('.data', 'transfer-demo', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(path.dirname(root), { recursive: true });
// A new destination keeps fixture generation separate from existing validation data.
await mkdir(root);
const a = path.join(root, 'machine-a');
const b = path.join(root, 'machine-b');
const fixture = {
  videoId: 'dQw4w9WgXcQ', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'A：森林觀測搬移測試', channelId: 'UC-transfer-demo', channelTitle: '搬移測試頻道',
  publishedAt: '2026-09-18T00:00:00.000Z', languageCode: 'zh-Hant', languageName: '繁體中文',
  subtitleKind: 'manual', bodyMarkdown: '這是合成測試資料，搜尋關鍵字：森林觀測。\n\n資料包含有二進位附件 attachments/sample.bin。',
};
await new MarkdownVault(path.join(a, 'vault')).add(fixture);
await new MarkdownVault(path.join(a, 'vault')).add({ ...fixture,
  videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  title: 'A：第二份英文測試文件', bodyMarkdown: 'Portable migration evidence: orchid research.',
});
await new JsonChannelStore(path.join(a, 'vault')).add({
  id: 'UC-transfer-demo', title: '搬移測試頻道', url: 'https://www.youtube.com/channel/UC-transfer-demo',
  enabled: true, addedAt: new Date().toISOString(),
});
await new JsonChannelScheduleStore(path.join(a, 'vault')).save({
  enabled: true, intervalMinutes: 60, nextRunAt: '2099-01-01T00:00:00.000Z',
  lastAttemptAt: null, lastCompletedAt: null, lastResult: null,
});
await mkdir(path.join(a, 'vault', 'attachments'), { recursive: true });
await writeFile(path.join(a, 'vault', 'attachments', 'sample.bin'), Buffer.from([0, 1, 128, 255]));
await new MarkdownVault(path.join(b, 'vault')).add({ ...fixture,
  videoId: '12345678901', sourceUrl: 'https://www.youtube.com/watch?v=12345678901',
  title: 'B：原 vault 保留驗證', bodyMarkdown: '這份文件留在 B 原本的 vault，還原後不應混入 A 的文件列表。',
});
await writeFile(path.join(root, 'machine-a.xr-vault'), await exportVault(path.join(a, 'vault')));
await writeFile(path.join(root, 'machine-b.xr-vault'), await exportVault(path.join(b, 'vault')));
console.log(`合成資料：${root}\n在各自的 validation 工作區匯入 machine-a.xr-vault／machine-b.xr-vault；還原後排程暫停。`);
