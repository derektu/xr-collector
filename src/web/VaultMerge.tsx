import { useMemo, useState } from 'react';
import type { MergePreview, MergeChoice, TransferStatus } from '../core/types.js';
import { lineDiff } from './line-diff.js';

async function request(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}
function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  return <pre className="merge-diff" aria-label="版本差異">{lines.map((line, index) => <span key={index} className={`diff-${line.kind}`}>{line.kind === 'removed' ? '− ' : line.kind === 'added' ? '+ ' : '  '}{line.text}{'\n'}</span>)}</pre>;
}
export function VaultMerge({ file, disabled, onBusy, onStatus }: {
  file: File | null; disabled: boolean; onBusy: (busy: boolean) => void; onStatus: (status: TransferStatus) => void;
}) {
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  async function compare() {
    if (!file) return;
    onBusy(true); setError(''); setFinished(false); setPreview(null);
    try {
      if (file.size > 128 * 1024 * 1024) throw new Error('資料包超過 128 MiB。');
      setPreview(await request('/api/vault/merge/preview', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }) as MergePreview);
      setSourceName(file.name); setChoices({});
    } catch (caught) { setError(caught instanceof Error ? caught.message : '比對失敗。'); }
    finally { onBusy(false); }
  }
  async function submit(cancel = false) {
    if (!preview) return;
    onBusy(true); setError('');
    try {
      const response = await request(`/api/vault/merge/${cancel ? 'cancel' : 'apply'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: preview.id, choices }) });
      if (cancel) { setPreview(null); return; }
      let status = response as TransferStatus;
      onStatus(status);
      while (!['completed', 'error'].includes(status.state)) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        status = await request('/api/vault/status', {}) as TransferStatus; onStatus(status);
      }
      if (status.state === 'error') throw new Error(status.message);
      setPreview(null); setFinished(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '合併失敗。'); }
    finally { onBusy(false); }
  }
  const conflicts = preview?.items.filter((item) => item.state === 'conflict') ?? [];
  return <section className="vault-merge">
    <button disabled={!file || disabled} onClick={() => void compare()}>比對並合併到目前 vault</button>
    {preview && <>
      <h3>資料包：{sourceName}</h3>
      <p>新增 {preview.items.filter((item) => item.state === 'new').length} · 相同 {preview.items.filter((item) => item.state === 'same').length} · 差異 {conflicts.length}</p>
      <p>新增項目會加入，相同項目會跳過；來源缺少的項目保留本機。每項差異都需要選擇。</p>
      <p>文件時間取自異動時間（若有）或收集時間，頻道顯示加入時間，僅供參考。採用匯入排程會套用週期並暫停排程；執行紀錄保留本機。</p>
      {preview.items.map((item) => <details key={item.key} className="merge-item">
        <summary>{item.state === 'new' ? '新增' : item.state === 'same' ? '相同' : '差異'} · {item.label}{item.state === 'conflict' ? ` · ${choices[item.key] === 'local' ? '保留本機' : choices[item.key] === 'incoming' ? '採用匯入' : '尚未選擇'}` : ''}</summary>
        {item.state === 'conflict' && <fieldset disabled={disabled}>
          <legend>處理方式</legend>
          <label><input type="radio" name={item.key} checked={choices[item.key] === 'local'} onChange={() => setChoices({ ...choices, [item.key]: 'local' })} />保留本機</label>
          <label><input type="radio" name={item.key} checked={choices[item.key] === 'incoming'} onChange={() => setChoices({ ...choices, [item.key]: 'incoming' })} />採用匯入</label>
        </fieldset>}
        <p>本機時間：{item.localTime ?? '未提供'} ｜ 匯入時間：{item.incomingTime ?? '未提供'}</p>
        {item.state !== 'same' && <><p>− 本機移除內容　+ 匯入加入內容</p><Diff before={item.localText} after={item.incomingText} /></>}
      </details>)}
      <div className="vault-actions">
        <button disabled={disabled || conflicts.some((item) => !choices[item.key])} onClick={() => void submit()}>確認合併</button>
        <button disabled={disabled} onClick={() => void submit(true)}>取消合併</button>
      </div>
    </>}
    {finished && <p>合併完成。<button onClick={() => window.location.reload()}>重新載入文件與頻道</button></p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
