import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { DocumentSummary, SavedDocument } from '../core/types.js';
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
  const [selected, setSelected] = useState<SavedDocument | null>(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedId = selected?.id ?? null;
  const documentCount = useMemo(() => documents.length, [documents]);

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

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCollecting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.collectYouTube(url);
      setUrl('');
      setSelected(result.document);
      await refreshDocuments(result.document.id);
      setMessage(result.status === 'created' ? '字幕已保存到本機 vault。' : '這支影片已經收集過，已開啟既有文件。');
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
            {loading ? (
              <p className="empty-state">正在讀取 vault…</p>
            ) : documents.length === 0 ? (
              <p className="empty-state">尚未保存字幕。從上方貼入第一支影片網址。</p>
            ) : (
              <ul className="document-list">
                {documents.map((document) => (
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
