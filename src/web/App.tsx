import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DocumentSummary,
  SavedDocument,
  SearchHit,
  SearchState,
  SearchStatus,
  YouTubeChannel,
  ChannelRun,
  ChannelSchedule,
} from '../core/types.js';
import { VaultTransfer } from './VaultTransfer.js';
import { api } from './api-client.js';
import { scheduleDocumentRefresh } from './schedule-document-refresh.js';

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

function formatDateTime(value: string | null): string {
  if (!value) return '尚無';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-TW', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export default function App() {
  const [agentInfo, setAgentInfo] = useState<Awaited<ReturnType<typeof api.agentConnection>> | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
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
  const [channels, setChannels] = useState<YouTubeChannel[]>([]);
  const [channelUrl, setChannelUrl] = useState('');
  const [channelAction, setChannelAction] = useState(false);
  const [activeRun, setActiveRun] = useState<ChannelRun | null>(null);
  const [schedule, setSchedule] = useState<ChannelSchedule | null>(null);
  const [scheduleInterval, setScheduleInterval] = useState(60);
  const [scheduleAction, setScheduleAction] = useState(false);
  const observedScheduleCompletion = useRef<string | null>(null);

  const selectedId = selected?.id ?? null;
  const documentCount = useMemo(() => documents.length, [documents]);
  const documentChannels = useMemo(
    () => [...new Set(documents.map((document) => document.channelTitle))].sort((left, right) => left.localeCompare(right, 'zh-Hant')),
    [documents],
  );
  const visibleDocuments = searchResults ?? documents;
  const scheduleTiming = schedule ? scheduleTimingLabels(schedule) : null;

  useEffect(() => {
    void api.agentConnection().then(setAgentInfo).catch(() => setAgentError('無法取得 Agent 連線資訊，請重新啟動程式。'));
  }, []);

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
    let loaded = false;
    async function refreshSchedule(): Promise<void> {
      try {
        const next = await api.getChannelSchedule();
        if (stopped) return;
        setSchedule(next);
        if (!loaded) setScheduleInterval(next.intervalMinutes);
        loaded = true;
        const documentRefresh = scheduleDocumentRefresh(observedScheduleCompletion.current, next);
        if (documentRefresh === 'completion') {
          await refreshDocuments();
          setSearchResults(null);
          setSearchStatus(await api.getSearchStatus());
        } else if (documentRefresh === 'progress') {
          setDocuments(await api.listDocuments());
        }
        observedScheduleCompletion.current = next.lastCompletedAt;
      } catch (caught) {
        if (!stopped && !loaded) {
          setError(caught instanceof Error ? caught.message : '無法載入頻道排程。');
        }
      }
    }
    void refreshSchedule();
    const timer = window.setInterval(() => void refreshSchedule(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    api.listChannels()
      .then(setChannels)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '無法載入頻道清單。');
      });
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

  useEffect(() => {
    if (!activeRun || activeRun.status === 'completed') return;
    let stopped = false;
    const timer = window.setInterval(() => void poll(), 500);
    async function poll(): Promise<void> {
      try {
        const next = await api.getChannelRun(activeRun!.id);
        if (stopped) return;
        setActiveRun(next);
        if (next.status === 'completed') {
          window.clearInterval(timer);
          await refreshDocuments();
          setSearchResults(null);
          setSearchStatus(await api.getSearchStatus());
          setMessage(`頻道收集完成：新增 ${next.created}、略過 ${next.existing}、失敗 ${next.failed}。`);
        }
      } catch (caught) {
        if (!stopped) {
          setError(caught instanceof Error ? caught.message : '無法讀取頻道收集進度。');
          window.clearInterval(timer);
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeRun?.id, activeRun?.status]);

  async function addChannel(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setChannelAction(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.addChannel(channelUrl);
      setChannelUrl('');
      setChannels(await api.listChannels());
      setMessage(result.status === 'created' ? '頻道已加入清單。' : '這個頻道已經在清單中。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無法新增頻道。');
    } finally {
      setChannelAction(false);
    }
  }

  async function setChannelEnabled(channelId: string, enabled: boolean): Promise<void> {
    setChannelAction(true);
    setError(null);
    try {
      const updated = await api.setChannelEnabled(channelId, enabled);
      setChannels((current) => current.map((channel) => (
        channel.id === updated.id ? updated : channel
      )));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無法更新頻道設定。');
    } finally {
      setChannelAction(false);
    }
  }

  async function removeChannel(channelId: string): Promise<void> {
    setChannelAction(true);
    setError(null);
    try {
      await api.removeChannel(channelId);
      setChannels((current) => current.filter((channel) => channel.id !== channelId));
      setMessage('頻道已從清單移除；既有字幕文件仍保留。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無法移除頻道。');
    } finally {
      setChannelAction(false);
    }
  }

  async function startChannelRun(channelIds?: string[]): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      setActiveRun(await api.startChannelRun(channelIds));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無法開始頻道收集。');
    }
  }

  async function saveSchedule(enabled: boolean): Promise<void> {
    setScheduleAction(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.updateChannelSchedule(enabled, scheduleInterval);
      setSchedule(updated);
      setScheduleInterval(updated.intervalMinutes);
      setMessage(enabled ? '自動抓取排程已更新。' : '自動抓取已暫停。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '無法更新頻道排程。');
    } finally {
      setScheduleAction(false);
    }
  }

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
        <VaultTransfer />
        <details className="agent-panel">
          <summary>Agent 存取 · 僅供本機讀取</summary>
          <p>讓 Agent 使用下方 Skill 瀏覽、搜尋與讀取這份知識庫。連線檔含只讀 token，每次啟動會更新；請保留在本機。</p>
          {agentInfo ? (
            <dl>
              <dt>HTTP 位址</dt><dd>{agentInfo.url}</dd>
              <dt>連線檔</dt><dd>{agentInfo.connectionFile}</dd>
              <dt>Skill 目錄</dt><dd>{agentInfo.skillPath}</dd>
            </dl>
          ) : <p role="status">{agentError ?? '正在讀取連線資訊…'}</p>}
          <p>把 Skill 目錄交給支援 Skill 的本機 Agent，並指定上方連線檔。程式需保持開啟。</p>
        </details>
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

        <section className="channels-panel" aria-labelledby="channels-title">
          <div className="channels-heading">
            <div>
              <p className="eyebrow">CHANNELS</p>
              <h2 id="channels-title">追蹤頻道</h2>
              <p>每次抓取各頻道最近 10 支影片；已收集的影片會略過。</p>
            </div>
            <button
              type="button"
              onClick={() => void startChannelRun()}
              disabled={channelAction || activeRun?.status === 'running' || !channels.some((item) => item.enabled)}
            >
              {activeRun?.status === 'running' ? '抓取中…' : '抓取已啟用頻道'}
            </button>
          </div>
          <form className="channel-form" onSubmit={(event) => void addChannel(event)}>
            <label htmlFor="youtube-channel-url">YouTube 頻道網址或 @handle</label>
            <div>
              <input
                id="youtube-channel-url"
                value={channelUrl}
                onChange={(event) => setChannelUrl(event.target.value)}
                placeholder="https://www.youtube.com/@…"
                disabled={channelAction}
                required
              />
              <button type="submit" disabled={channelAction || !channelUrl.trim()}>
                {channelAction ? '處理中…' : '新增頻道'}
              </button>
            </div>
          </form>
          {channels.length === 0 ? (
            <p className="channel-empty">尚未加入頻道。</p>
          ) : (
            <ul className="channel-list">
              {channels.map((item) => (
                <li key={item.id}>
                  <label className="channel-toggle">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(event) => void setChannelEnabled(item.id, event.target.checked)}
                      disabled={channelAction || activeRun?.status === 'running'}
                    />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.id}</small>
                    </span>
                  </label>
                  <div className="channel-actions">
                    <button
                      type="button"
                      onClick={() => void startChannelRun([item.id])}
                      disabled={channelAction || activeRun?.status === 'running'}
                    >立即抓取</button>
                    <button
                      className="remove-channel"
                      type="button"
                      onClick={() => void removeChannel(item.id)}
                      disabled={channelAction || activeRun?.status === 'running'}
                    >移除</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="schedule-panel">
            <div className="schedule-heading">
              <div>
                <strong>自動抓取</strong>
                <span>{schedule ? scheduleStatusLabel(schedule) : '正在讀取排程…'}</span>
              </div>
              {schedule?.enabled && (
                <button
                  type="button"
                  className="pause-schedule"
                  onClick={() => void saveSchedule(false)}
                  disabled={scheduleAction}
                >暫停排程</button>
              )}
            </div>
            <div className="schedule-controls">
              <label htmlFor="schedule-interval">抓取週期</label>
              <select
                id="schedule-interval"
                value={scheduleInterval}
                onChange={(event) => setScheduleInterval(Number(event.target.value))}
                disabled={scheduleAction}
              >
                <option value={1}>每 1 分鐘（示範）</option>
                <option value={5}>每 5 分鐘</option>
                <option value={15}>每 15 分鐘</option>
                <option value={60}>每 1 小時</option>
                <option value={360}>每 6 小時</option>
                <option value={1440}>每天</option>
              </select>
              <button
                type="button"
                onClick={() => void saveSchedule(true)}
                disabled={scheduleAction || !schedule || channels.length === 0}
              >{schedule?.enabled ? '更新週期' : '啟用排程'}</button>
            </div>
            {schedule && scheduleTiming && (
              <div className="schedule-details">
                <span>{scheduleTiming.startLabel}：{formatDateTime(schedule.lastAttemptAt)}</span>
                <span>{scheduleTiming.completionLabel}：{formatDateTime(schedule.lastCompletedAt)}</span>
                <span>下次執行：{scheduleTiming.nextRunLabel}</span>
                {schedule.lastResult && (
                  <span className={schedule.lastResult.failed > 0 ? 'schedule-result warning' : 'schedule-result'}>
                    上次結果：新增 {schedule.lastResult.created}、略過 {schedule.lastResult.existing}、失敗 {schedule.lastResult.failed}
                    {schedule.lastResult.error ? ` · ${schedule.lastResult.error}` : ''}
                  </span>
                )}
              </div>
            )}
          </div>
          {activeRun && (
            <div className="channel-run" aria-live="polite">
              <div className="run-summary">
                <strong>{activeRun.status === 'completed' ? '本次結果' : '正在抓取頻道'}</strong>
                <span>已處理 {activeRun.processedVideos}／目前發現 {activeRun.totalVideos}</span>
                <span>新增 {activeRun.created} · 略過 {activeRun.existing} · 失敗 {activeRun.failed}</span>
              </div>
              {activeRun.results.length > 0 && (
                <ul className="run-results">
                  {activeRun.results.map((result, index) => (
                    <li key={`${result.channelId}:${result.videoId ?? 'channel'}:${index}`} className={result.status}>
                      <span>{result.status === 'created' ? '新增' : result.status === 'existing' ? '略過' : '失敗'}</span>
                      <div>
                        <strong>{result.videoTitle}</strong>
                        <small>{result.channelTitle}{result.error ? ` · ${result.error.message}` : ''}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {activeRun.failed > 0 && activeRun.status === 'completed' && (
                <p className="run-retry-hint">可再次執行該頻道；已取得的影片會略過，只重試尚未成功的項目。</p>
              )}
            </div>
          )}
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
                  {documentChannels.map((name) => <option key={name} value={name}>{name}</option>)}
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

function scheduleStatusLabel(schedule: ChannelSchedule): string {
  switch (schedule.status) {
    case 'paused': return '已暫停';
    case 'scheduled': return '等待下一次執行';
    case 'running': return '正在自動抓取';
    case 'waiting_for_run': return '等待目前抓取完成';
  }
}

export function scheduleTimingLabels(schedule: ChannelSchedule): {
  startLabel: string;
  completionLabel: string;
  nextRunLabel: string;
} {
  const running = schedule.status === 'running';
  return {
    startLabel: running ? '本次開始' : '上次開始',
    completionLabel: running ? '前次完成' : '上次完成',
    nextRunLabel: scheduleNextRunLabel(schedule),
  };
}

function scheduleNextRunLabel(schedule: ChannelSchedule): string {
  switch (schedule.status) {
    case 'paused': return '已暫停';
    case 'running': return `本次完成 ${formatScheduleInterval(schedule.intervalMinutes)}後`;
    case 'waiting_for_run': return '目前抓取完成後執行';
    case 'scheduled': return formatDateTime(schedule.nextRunAt);
  }
}

function formatScheduleInterval(minutes: number): string {
  if (minutes === 1440) return '1 天';
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分鐘`;
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
