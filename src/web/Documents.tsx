import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { DOCUMENT_ADD_ITEMS, type AddMode } from './add-menu.js';
import { AddMenu } from './AddMenu.js';
import { ConfirmDeleteDocument } from './ConfirmDeleteDocument.js';
import type { DocumentMetadata, DocumentSources } from '../core/types.js';
import { trimSearchQueryWhitespace } from '../core/search-query.js';
import { ApiError, api } from './api-client.js';
import { OFFLINE_UNAVAILABLE } from './app-shell.js';
import {
  DOCUMENTS_PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  collectedShortLabel,
  draftForQuery,
  pageWithRows,
  pageItems,
  publishedLabel,
  readerPath,
  snippetParts,
  sourceFilter,
  sourceOptions,
  sourceTag,
  totalPages,
  type DocumentListState,
} from './document-presentation.js';
import { createLatestRequest } from './latest-request.js';
import { useFloatingMenu } from './floating-menu.js';
import { Icon } from './icons.js';

interface Row {
  document: DocumentMetadata;
  excerpt?: string;
  snippet?: string;
}

interface Results {
  mode: 'browse' | 'search';
  rows: Row[];
  total: number;
}

/** History state the list entry keeps so returning from the Reader can restore the scroll position. */
interface ListHistoryState {
  documentsScroll?: number;
}

export function Documents({ state, revision, offline, scroller, onState, onOpen, onNavigate, onAdd, onChanged }: {
  state: DocumentListState;
  /** Changes when a job ends or saves a document, so documents collected meanwhile show up. */
  revision: number;
  /** The device has no network, so adding is unavailable. */
  offline: boolean;
  /** The scrolling element whose position is saved before opening the Reader. */
  scroller: () => HTMLElement | null;
  onState: (state: DocumentListState) => void;
  onOpen: (id: string) => void;
  onNavigate: (page: 'settings') => void;
  /** Opens the add dialog the menu item names. */
  onAdd: (mode: AddMode) => void;
  /** Reports the result of a row action. */
  onChanged: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const [draft, setDraft] = useState(state.query);
  const [sources, setSources] = useState<DocumentSources | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [searchProblem, setSearchProblem] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Bumped after a deletion, so the sources and the current page load again. */
  const [deletions, setDeletions] = useState(0);
  const requests = useMemo(createLatestRequest, []);
  const restoreScroll = useRef<number | null>((window.history.state as ListHistoryState | null)?.documentsScroll ?? null);

  useEffect(() => { setDraft((current) => draftForQuery(current, state.query)); }, [state.query]);

  useEffect(() => {
    const controller = new AbortController();
    api.documentSources(controller.signal).then(setSources).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '無法讀取頻道清單。');
    });
    return () => controller.abort();
  }, [revision, deletions]);

  // Typing updates the URL after a pause; the URL is what drives loading.
  useEffect(() => {
    const query = trimSearchQueryWhitespace(draft);
    if (query === state.query) return undefined;
    const timer = setTimeout(() => onState({ query, source: state.source, page: 1 }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, state.query, state.source, onState]);

  useEffect(() => {
    let active = true;
    const filter = sourceFilter(state.source);
    const offset = (state.page - 1) * DOCUMENTS_PAGE_SIZE;
    const browse = (signal: AbortSignal) => api.listDocuments({ ...filter, offset, limit: DOCUMENTS_PAGE_SIZE }, signal)
      .then((page): Results => ({ mode: 'browse', rows: page.documents.map((document) => ({ document, excerpt: document.excerpt })), total: page.total }));
    setLoading(true);
    void requests.run(async (signal) => {
      if (!state.query) return { results: await browse(signal), problem: null };
      try {
        const found = await api.searchDocuments({ query: state.query, ...filter, offset, limit: DOCUMENTS_PAGE_SIZE }, signal);
        return {
          results: { mode: 'search', rows: found.hits.map((hit) => ({ document: hit, snippet: hit.snippet })), total: found.total } satisfies Results,
          problem: null,
        };
      } catch (error) {
        // Browsing and reading do not depend on the search engine, so fall back to the Vault list.
        if (error instanceof ApiError && error.code === 'search_unavailable') {
          return { results: await browse(signal), problem: error.message };
        }
        throw error;
      }
    }).then((outcome) => {
      if (!active || !outcome.current) return;
      const { rows, total } = outcome.value.results;
      const page = pageWithRows(state.page, rows.length, total);
      if (page !== state.page) { onState({ ...state, page }); return; }
      setResults(outcome.value.results);
      setSearchProblem(outcome.value.problem);
      setLoadError(null);
      setLoading(false);
    }).catch((error: unknown) => {
      if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
      setLoadError(error instanceof Error ? error.message : '無法讀取文件。');
      setLoading(false);
    });
    return () => { active = false; };
  }, [state.query, state.source, state.page, requests, revision, deletions]);

  useEffect(() => () => requests.cancel(), [requests]);

  useLayoutEffect(() => {
    if (!results || restoreScroll.current === null) return;
    const element = scroller();
    if (element) element.scrollTop = restoreScroll.current;
    restoreScroll.current = null;
  }, [results, scroller]);

  function open(event: MouseEvent<HTMLAnchorElement>, id: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    const scrollTop = scroller()?.scrollTop ?? 0;
    const current = (window.history.state ?? {}) as ListHistoryState;
    window.history.replaceState({ ...current, documentsScroll: scrollTop } satisfies ListHistoryState, '');
    onOpen(id);
  }

  function deleted(message: string): void {
    onChanged(message);
    setDeletions((value) => value + 1);
  }

  const options = sourceOptions(sources);
  const pages = totalPages(results?.total ?? 0);
  const emptyVault = sources?.total === 0;

  const heading = <div className="page-header">
    <h1 className="page-title" tabIndex={-1} data-page-heading>文件</h1>
    <div className="header-actions"><AddMenu label="新增" items={DOCUMENT_ADD_ITEMS} onChoose={onAdd} disabledReason={offline ? OFFLINE_UNAVAILABLE : null} testId="add-document" /></div>
  </div>;
  if (emptyVault) {
    return <>
      {heading}
      <section className="empty-state" data-testid="documents-empty-vault">
        <h2>知識庫裡還沒有文件</h2>
        <AddMenu label="新增" items={DOCUMENT_ADD_ITEMS} onChoose={onAdd} primary align="start" disabledReason={offline ? OFFLINE_UNAVAILABLE : null} testId="add-document-empty" />
      </section>
    </>;
  }

  return <>
    {heading}
    <div className="documents-toolbar" role="search">
      <label className="search-field">
        <span className="visually-hidden">搜尋文件</span>
        <span className="search-icon" aria-hidden="true"><Icon name="search" size={15} /></span>
        <input
          type="search"
          value={draft}
          placeholder="搜尋文件內容…"
          maxLength={500}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') onState({ ...state, query: trimSearchQueryWhitespace(draft), page: 1 }); }}
          data-testid="documents-search"
        />
        {draft ? <button type="button" className="search-clear" aria-label="清除搜尋" onClick={() => { setDraft(''); onState({ ...state, query: '', page: 1 }); }}>×</button> : null}
      </label>
      <label className="source-select">
        <span className="visually-hidden">篩選文件</span>
        <Icon name="sources" size={15} />
        <select value={state.source} onChange={(event) => onState({ ...state, source: event.target.value, page: 1 })}
          onPointerDown={(event) => { event.currentTarget.dataset.pointerFocus = 'true'; }}
          onKeyDown={(event) => { delete event.currentTarget.dataset.pointerFocus; }}
          onBlur={(event) => { delete event.currentTarget.dataset.pointerFocus; }} data-testid="documents-source">
          <option value={options.all.value}>{options.all.label}</option>
          {options.groups.map((group) => <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </optgroup>)}
        </select>
      </label>
    </div>

    {searchProblem ? <div className="search-warning" role="alert" data-testid="search-unavailable">
      <p><strong>搜尋暫時無法使用</strong>：{searchProblem} 下方先列出知識庫的文件，閱讀不受影響。</p>
      <button type="button" onClick={() => onNavigate('settings')}>前往設定</button>
    </div> : null}

    <div className="documents-summary" aria-live="polite" data-testid="documents-summary">
      {loadError ? <span className="documents-error">{loadError}</span>
        : results ? results.mode === 'search' ? `找到 ${results.total} 份` : `共 ${results.total} 份文件`
          : '正在載入…'}
      {loading && results ? <span className="documents-loading">更新中…</span> : null}
    </div>

    {results && results.rows.length === 0 ? <section className="documents-none" data-testid="documents-no-results">
      {results.mode === 'search'
        ? <h3>沒有符合「{state.query}」的文件</h3>
        : <h3>這個頻道目前沒有文件</h3>}
    </section> : null}

    {results && results.rows.length > 0 ? <ol className="document-list" data-testid="document-list">
      {results.rows.map(({ document, excerpt, snippet }) => <li key={document.id} className="document-item">
        <a className="document-row" href={readerPath(document.id)} onClick={(event) => open(event, document.id)}>
          <span className="document-main">
            <span className="document-title">{document.title}</span>
            <span className="document-excerpt">{snippet !== undefined
              ? snippetParts(snippet).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)
              : excerpt}</span>
          </span>
          <span className="document-meta">
            <span className="source-tag">{sourceTag(document)}</span>
            <span className={document.publishedAt ? 'document-date' : 'document-date unknown'}>{publishedLabel(document.publishedAt)}</span>
            <span className="document-collected">{collectedShortLabel(document.collectedAt)}</span>
          </span>
        </a>
        <DocumentActions document={document} onDeleted={deleted} />
      </li>)}
    </ol> : null}

    {results && results.total > DOCUMENTS_PAGE_SIZE ? <nav className="pagination" aria-label="分頁" data-testid="documents-pagination">
      <button type="button" disabled={state.page <= 1} onClick={() => onState({ ...state, page: state.page - 1 })}>上一頁</button>
      {pageItems(state.page, pages).map((page, index) => page === null
        ? <span key={`gap-${index}`} className="page-gap">…</span>
        : <button key={page} type="button" className={page === state.page ? 'page-number current' : 'page-number'} aria-current={page === state.page ? 'page' : undefined} onClick={() => onState({ ...state, page })}>{page}</button>)}
      <button type="button" disabled={state.page >= pages} onClick={() => onState({ ...state, page: state.page + 1 })}>下一頁</button>
    </nav> : null}
  </>;
}

/** The more-actions menu of one list row. */
function DocumentActions({ document: item, onDeleted }: { document: DocumentMetadata; onDeleted: (message: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const menuList = useRef<HTMLDivElement>(null);
  useFloatingMenu(menuOpen, moreButton, menuList);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  return <div className="document-actions">
    <div className="menu-anchor" ref={menu}>
      <button ref={moreButton} type="button" className="icon-only" aria-label={`${item.title} 的更多動作`} aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)} data-testid="document-more"><Icon name="more" size={15} /></button>
      {menuOpen ? <div ref={menuList} className="menu" role="menu">
        <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setDeleting(true); }}>刪除</button>
      </div> : null}
    </div>
    {deleting ? <ConfirmDeleteDocument document={item} onCancel={() => setDeleting(false)}
      onDeleted={(message) => { setDeleting(false); onDeleted(message); }} /> : null}
  </div>;
}
