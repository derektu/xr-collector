import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  DocumentSummary,
  SavedDocument,
  SearchHit,
  SearchState,
  SearchStatus,
} from '../core/types.js';
import { api } from './api-client.js';

function formatDate(value: string | null): string {
  if (!value) return '發布時間未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export default function App() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [channel, setChannel] = useState('');
  const [publishedFrom, setPublishedFrom] = useState('');
  const [publishedTo, setPublishedTo] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>({
    state: 'starting',
    indexedDocuments: 0,
  });
  const [selected, setSelected] = useState<SavedDocument | null>(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedId = selected?.id ?? null;
  const documentCount = useMemo(() => documents.length, [documents]);
  const channels = useMemo(
    () => [...new Set(documents.map((document) => document.channelTitle))].sort((left, right) => left.localeCompare(right, 'zh-Hant')),
    [documents],
  );
  const visibleDocuments = searchResults ?? documents;

  async function refreshDocuments(preferredId?: string): Promise<void> {
    const items = await api.listDocuments();
    setDocuments(items);
    const nextId = preferredId ?? selectedId ?? items[0]?.id;
    if (nextId) setSelected(await api.readDocument(nextId));
  }

  useEffect(() => {
    refreshDocuments()
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '無法載入文件。');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let stopped = false;
    async function refreshSearchStatus(): Promise<void> {
      try {
        const nextStatus = await api.getSearchStatus();
        if (!stopped) setSearchStatus(nextStatus);
      } catch (caught) {
        if (!stopped) {
          setSearchStatus({
            state: 'error',
            indexedDocuments: 0,
            message: caught instanceof Error ? caught.message : '無法讀取搜尋狀態。',
          });
        }
      }
    }
    void refreshSearchStatus();
    const timer = window.setInterval(() => void refreshSearchStatus(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCollecting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.collectYouTube(url);
      setUrl('');
      setSelected(result.document);
      setSearchStatus(result.searchStatus);
      await refreshDocuments(result.document.id);
      setSearchResults(null);
      setMessage(
        result.searchStatus.state === 'error'
          ? '字幕已保存到 vault，但搜尋索引更新失敗。'
          : result.status === 'created'
            ? '字幕已保存到本機 vault 並完成索引。'
            : '這支影片已經收集過，已開啟既有文件。',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '字幕取得失敗。');
    } finally {
      setCollecting(false);
    }
  }

  async function selectDocument(id: string): Promise<void> {
    setError(null);
    try {
      setSelected(await api.readDocument(id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無法開啟文件。');
    }
  }

  async function submitSearch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const result = await api.searchDocuments({
        query: searchQuery.trim(),
        ...(channel ? { channel } : {}),
        ...(publishedFrom ? { publishedFrom } : {}),
        ...(publishedTo ? { publishedTo } : {}),
      });
      setSearchResults(result.hits);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '搜尋失敗。');
    } finally {
      setSearching(false);
    }
  }

  function clearSearch(): void {
    setSearchQuery('');
    setChannel('');
    setPublishedFrom('');
    setPublishedTo('');
    setSearchResults(null);
  }

  async function rebuildSearch(): Promise<void> {
    setError(null);
    setSearchStatus((current) => ({ ...current, state: 'rebuilding', message: undefined }));
    try {
      setSearchStatus(await api.rebuildSearch());
      setMessage('搜尋索引已從 vault 重建。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無法重建搜尋索引。');
      setSearchStatus(await api.getSearchStatus().catch(() => ({
        state: 'error' as const,
        indexedDocuments: 0,
        message: '無法重建搜尋索引。',
      })));
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">XR</div>
        <div>
          <div className="brand-name">XR Collector</div>
          <div className="brand-subtitle">YouTube transcript vault</div>
        </div>
        <div className="document-count">{documentCount} 份文件</div>
      </header>

      <main>
        <section className="collect-panel" aria-labelledby="collect-title">
          <div>
            <p className="eyebrow">COLLECT</p>
            <h1 id="collect-title">保存一支影片的字幕</h1>
            <p className="collect-description">貼上 YouTube 網址。XR Collector 只取得影片既有字幕，不會下載影音或啟動語音轉寫。</p>
          </div>
          <form className="collect-form" onSubmit={(event) => void submit(event)}>
            <label htmlFor="youtube-url">YouTube 影片網址</label>
            <div className="collect-row">
              <input
                id="youtube-url"
                type="url"
                inputMode="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                disabled={collecting}
                required
              />
              <button type="submit" disabled={collecting || !url.trim()}>
                {collecting ? '正在取得字幕…' : '收集字幕'}
              </button>
            </div>
          </form>
          {message && <div className="notice success" role="status">{message}</div>}
          {error && <div className="notice error" role="alert">{error}</div>}
        </section>

        <section className="workspace">
          <aside className="library" aria-label="已保存的影片">
            <div className="section-heading">
              <div>
                <p className="eyebrow">VAULT</p>
                <h2>已保存</h2>
              </div>
            </div>
            <form className="search-panel" onSubmit={(event) => void submitSearch(event)}>
              <label htmlFor="transcript-search">搜尋字幕</label>
              <div className="search-row">
                <input
                  id="transcript-search"
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="輸入字詞"
                  disabled={searchStatus.state !== 'ready' || searching}
                />
                <button type="submit" disabled={searchStatus.state !== 'ready' || searching}>
                  {searching ? '搜尋中…' : '搜尋'}
                </button>
              </div>
              <div className="search-filters">
                <select
                  aria-label="頻道"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                  disabled={searchStatus.state !== 'ready' || searching}
                >
                  <option value="">所有頻道</option>
                  {channels.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <label>
                  <span>從</span>
                  <input
                    type="date"
                    value={publishedFrom}
                    onChange={(event) => setPublishedFrom(event.target.value)}
                    disabled={searchStatus.state !== 'ready' || searching}
                  />
                </label>
                <label>
                  <span>到</span>
                  <input
                    type="date"
                    value={publishedTo}
                    onChange={(event) => setPublishedTo(event.target.value)}
                    disabled={searchStatus.state !== 'ready' || searching}
                  />
                </label>
              </div>
              {searchResults && (
                <button className="clear-search" type="button" onClick={clearSearch}>
                  清除搜尋
                </button>
              )}
            </form>
            <SearchStatusPanel status={searchStatus} onRebuild={() => void rebuildSearch()} />
            {searchResults && (
              <div className="result-count" role="status">
                找到 {searchResults.length} 份文件
              </div>
            )}
            {loading ? (
              <p className="empty-state">正在讀取 vault…</p>
            ) : visibleDocuments.length === 0 ? (
              searchResults ? (
                <p className="empty-state">沒有符合這些條件的字幕。</p>
              ) : (
              <p className="empty-state">尚未保存字幕。從上方貼入第一支影片網址。</p>
              )
            ) : (
              <ul className="document-list">
                {visibleDocuments.map((document) => (
                  <li key={document.id}>
                    <button
                      className={document.id === selectedId ? 'document-card active' : 'document-card'}
                      onClick={() => void selectDocument(document.id)}
                    >
                      <span className="document-title">{document.title}</span>
                      <span className="document-channel">{document.channelTitle}</span>
                      <span className="document-meta">
                        {formatDate(document.publishedAt)} · {document.languageCode}
                      </span>
                      {isSearchHit(document) && (
                        <span className="result-snippet">{document.snippet}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <article className="reader">
            {!selected ? (
              <div className="reader-empty">
                <div className="reader-empty-icon" aria-hidden="true">◫</div>
                <h2>選擇一份字幕開始閱讀</h2>
                <p>文件保存在本機 Markdown vault，重新啟動後仍可使用。</p>
              </div>
            ) : (
              <>
                <header className="reader-header">
                  <div className="reader-badges">
                    <span>{selected.languageCode}</span>
                    <span>{selected.subtitleKind === 'manual' ? '人工字幕' : '自動字幕'}</span>
                  </div>
                  <h2>{selected.title}</h2>
                  <div className="reader-byline">
                    <span>{selected.channelTitle}</span>
                    <span>{formatDate(selected.publishedAt)}</span>
                    <a href={selected.sourceUrl} target="_blank" rel="noreferrer">開啟來源 ↗</a>
                  </div>
                </header>
                <div className="transcript" aria-label="字幕內容">
                  {selected.bodyMarkdown
                    .split(/\n{2,}/u)
                    .map((paragraph) => paragraph.trim())
                    .filter(Boolean)
                    .map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                </div>
              </>
            )}
          </article>
        </section>
      </main>
    </div>
  );
}

function isSearchHit(document: DocumentSummary | SearchHit): document is SearchHit {
  return 'snippet' in document;
}

function SearchStatusPanel({
  status,
  onRebuild,
}: {
  status: SearchStatus;
  onRebuild: () => void;
}) {
  const labels: Record<SearchState, string> = {
    starting: '正在啟動搜尋',
    updating: '正在更新索引',
    rebuilding: '正在從 vault 重建索引',
    ready: `搜尋已就緒 · ${status.indexedDocuments} 份`,
    error: '搜尋索引發生錯誤',
  };
  return (
    <div className={`search-status ${status.state}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      <span>
        <strong>{labels[status.state]}</strong>
        {status.message && <small>{status.message}</small>}
      </span>
      {status.state === 'error' && (
        <button type="button" onClick={onRebuild}>重建</button>
      )}
    </div>
  );
}
