import { useState } from 'react';
import type { SearchStatusReport } from '../core/types.js';
import { api } from './api-client.js';
import { dateTimeLabel } from './document-presentation.js';
import { useLiveRead } from './use-changes.js';

const STATE_LABELS: Record<SearchStatusReport['state'], string> = {
  starting: '啟動中', updating: '更新中', rebuilding: '重建中', ready: '就緒', error: '無法使用',
};

/** Settings section that shows whether the search index matches the Vault and lets the user rebuild it. */
export function SearchIndexCard() {
  const read = useLiveRead(['search'], (signal) => api.getSearchStatus(signal), []);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const status: SearchStatusReport | null = read.value;
  const loadError = read.error ? (read.error instanceof Error ? read.error.message : '無法讀取搜尋索引狀態。') : null;
  const busy = rebuilding || (status !== null && status.state !== 'ready' && status.state !== 'error');

  async function rebuild(): Promise<void> {
    setRebuilding(true);
    setRebuildError(null);
    try {
      await api.rebuildSearch();
    } catch (error) {
      setRebuildError(error instanceof Error ? error.message : '重建搜尋索引失敗。');
    } finally {
      setRebuilding(false);
    }
  }

  const state = rebuilding ? 'rebuilding' : status?.state;
  const mismatch = status?.state === 'ready' && status.indexedDocuments !== status.vaultDocuments;
  return <section className="settings-section search-index-card" data-testid="settings-search-index">
    <h2>搜尋</h2>
    {loadError ? <p className="documents-error">{loadError}</p> : null}
    {status && state ? <>
      <p className="index-state" data-testid="search-index-state"><span className={`status-light ${state}`} aria-hidden="true" />{STATE_LABELS[state]}</p>
      <p>已索引 {status.indexedDocuments} 份／知識庫 {status.vaultDocuments} 份</p>
      <p>上次重建：{status.lastRebuiltAt ? dateTimeLabel(status.lastRebuiltAt) : '尚未重建'}</p>
      {status.state === 'error' && status.message ? <p className="index-problem">原因：{status.message}</p> : null}
      {mismatch ? <p className="index-problem">索引篇數與知識庫不同，可以重建索引。</p> : null}
      {rebuildError ? <p className="index-problem">{rebuildError}</p> : null}
    </> : !loadError ? <p className="loading">正在讀取…</p> : null}
    <button type="button" className="button" disabled={busy || !status} onClick={() => void rebuild()}>{rebuilding ? '重建中…' : '重建索引'}</button>
  </section>;
}
