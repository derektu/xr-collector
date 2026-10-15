import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChannelPreview, ChannelSchedule, CollectionJob, Subscription } from '../core/types.js';
import { api } from './api-client.js';
import {
  hasActiveJobs,
  jobKindLabel,
  jobPhaseLabel,
  jobProgressLabel,
  jobResultLabel,
  jobStateLabel,
  jobTitle,
  skipReasonLabel,
  youtubeSubmitAction,
} from './job-presentation.js';
import {
  backfillPhrase,
  checkTimes,
  removeConfirmation,
  subscribeSummary,
  subscriptionDetail,
  subscriptionStatusLabel,
} from './subscription-presentation.js';

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;

type Notice = { tone: 'ok' | 'error'; text: string };
type PreviewState =
  | { state: 'resolving' }
  | { state: 'ready'; preview: ChannelPreview }
  | { state: 'error'; message: string };

interface Snapshot {
  jobs: CollectionJob[];
  subscriptions: Subscription[];
  schedule: ChannelSchedule;
}

/**
 * URL entry, subscriptions and collection jobs of the active Vault. A channel address opens an
 * inline confirmation before subscribing; a video address is collected at once. Jobs live in the
 * service, so leaving the page loses nothing.
 */
export function YouTubeSource({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => undefined);
  const previewSequence = useRef(0);
  const action = youtubeSubmitAction(url);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let sequence = 0;
    const load = async () => {
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const current = ++sequence;
      let delay = IDLE_POLL_MS;
      try {
        const [page, subscriptions, schedule] = await Promise.all([
          api.listJobs({ limit: 20 }, controller.signal),
          api.listChannels(controller.signal),
          api.getChannelSchedule(),
        ]);
        // A slower earlier response must not replace a newer list.
        if (!active || current !== sequence) return;
        setSnapshot({ jobs: page.jobs, subscriptions, schedule });
        setLoadError(null);
        if (hasActiveJobs(page.jobs)) delay = ACTIVE_POLL_MS;
      } catch (error) {
        if (!active || current !== sequence) return;
        setLoadError(error instanceof Error ? error.message : '無法讀取收集工作。');
      }
      timer = setTimeout(() => void load(), delay);
    };
    refresh.current = () => void load();
    void load();
    return () => { active = false; clearTimeout(timer); controller?.abort(); };
  }, []);

  function closePreview(): void {
    previewSequence.current += 1;
    setPreview(null);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!action.enabled || submitting) return;
    setNotice(null);
    if (action.kind === 'channel') {
      await openPreview(url);
      return;
    }
    closePreview();
    setSubmitting(true);
    try {
      const submission = await api.submitYouTube(url);
      setNotice({
        tone: 'ok',
        text: submission.deduplicated
          ? `這個項目已在處理中，沿用同一個工作：${jobTitle(submission.job)}`
          : `已接受${jobKindLabel(submission.job)}工作，可以繼續其他操作。`,
      });
      setUrl('');
      refresh.current();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '無法送出，請稍後再試。' });
    } finally {
      setSubmitting(false);
    }
  }

  async function openPreview(address: string): Promise<void> {
    const current = ++previewSequence.current;
    setPreview({ state: 'resolving' });
    try {
      const resolved = await api.previewChannel(address);
      if (current === previewSequence.current) setPreview({ state: 'ready', preview: resolved });
    } catch (error) {
      if (current === previewSequence.current) {
        setPreview({ state: 'error', message: error instanceof Error ? error.message : '無法解析這個頻道。' });
      }
    }
  }

  async function confirmSubscription(resolved: ChannelPreview): Promise<void> {
    setSubmitting(true);
    try {
      await api.addChannel(resolved.channel.url);
      setNotice({ tone: 'ok', text: `已訂閱「${resolved.channel.title}」，開始首次收集。` });
      setUrl('');
      closePreview();
      refresh.current();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '無法訂閱，請稍後再試。' });
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeSubscription(id: string, title: string): Promise<void> {
    setSubmitting(true);
    try {
      await api.setChannelEnabled(id, true);
      setNotice({ tone: 'ok', text: `已恢復「${title}」，開始補收。` });
      setUrl('');
      closePreview();
      refresh.current();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '無法恢復訂閱，請稍後再試。' });
    } finally {
      setSubmitting(false);
    }
  }

  const policy = snapshot?.schedule ?? null;
  return <section className="youtube-source" aria-label="YouTube 來源" data-testid="source-view-youtube">
    <h3>YouTube</h3>
    <form className="url-entry" onSubmit={(event) => void submit(event)}>
      <label className="visually-hidden" htmlFor="youtube-url">YouTube 網址</label>
      <input id="youtube-url" type="text" value={url} placeholder="貼上影片網址或頻道網址 / @handle…" autoComplete="off" spellCheck={false}
        aria-describedby="youtube-url-help" onChange={(event) => { setUrl(event.target.value); setNotice(null); closePreview(); }} />
      <button type="submit" disabled={!action.enabled || submitting || preview?.state === 'resolving'}>{submitting ? '送出中…' : action.label}</button>
    </form>
    {action.reason ? <p className="url-reason" role="status">{action.reason}</p> : null}
    {preview ? <PreviewCard
      preview={preview}
      busy={submitting}
      onConfirm={(resolved) => void confirmSubscription(resolved)}
      onResume={(resolved) => void resumeSubscription(resolved.channel.id, resolved.channel.title)}
      onClose={closePreview}
      onOpenSettings={onOpenSettings}
    /> : null}
    {notice ? <p className={`url-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
    <p className="url-help" id="youtube-url-help">貼上影片網址，將字幕內容加入知識庫。貼上頻道網址或 @handle，確認後收集近期內容並自動追蹤新內容。自動收集的頻率與範圍可在<button type="button" className="inline-link" onClick={onOpenSettings}>設定</button>中調整。</p>
    <SubscriptionList
      snapshot={snapshot}
      policy={policy}
      onChanged={(text, tone = 'ok') => { setNotice({ tone, text }); refresh.current(); }}
    />
    <JobList jobs={snapshot?.jobs ?? null} loadError={loadError} />
  </section>;
}

function PreviewCard({ preview, busy, onConfirm, onResume, onClose, onOpenSettings }: {
  preview: PreviewState;
  busy: boolean;
  onConfirm: (preview: ChannelPreview) => void;
  onResume: (preview: ChannelPreview) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  if (preview.state === 'resolving') {
    return <div className="subscribe-card" role="status" data-testid="subscribe-card">
      <p className="subscribe-resolving"><span className="spinner" aria-hidden="true" />正在解析頻道…</p>
      <div className="subscribe-actions"><button type="button" className="text-button" onClick={onClose}>取消</button></div>
    </div>;
  }
  if (preview.state === 'error') {
    return <div className="subscribe-card error" role="alert" data-testid="subscribe-card">
      <p>{preview.message}</p>
      <div className="subscribe-actions"><button type="button" className="text-button" onClick={onClose}>關閉</button></div>
    </div>;
  }
  const resolved = preview.preview;
  const summary = subscribeSummary(resolved.policy);
  const subscription = resolved.subscription;
  return <div className="subscribe-card" data-testid="subscribe-card">
    <div className="subscribe-heading">
      <p className="eyebrow">CHANNEL</p>
      <h4>{resolved.channel.title}</h4>
      {subscription ? <span className={`subscription-tag ${subscription.enabled ? 'tracking' : 'paused'}`}>{subscription.enabled ? '已訂閱' : '已暫停'}</span> : null}
    </div>
    {!subscription ? <>
      <p>{summary.text}{summary.settingsLead}<button type="button" className="inline-link" onClick={onOpenSettings}>設定</button>{summary.settingsTail}</p>
      <div className="subscribe-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={() => onConfirm(resolved)}>{busy ? '訂閱中…' : '確認訂閱'}</button>
        <button type="button" className="text-button" onClick={onClose}>取消</button>
      </div>
    </> : subscription.enabled ? <>
      <p>這個頻道已在訂閱清單中，會依自動收集設定持續檢查新內容。</p>
      <div className="subscribe-actions"><button type="button" className="text-button" onClick={onClose}>關閉</button></div>
    </> : <>
      <p>這個訂閱已暫停。恢復後補收{backfillPhrase(resolved.policy)}，再依自動收集設定持續檢查。</p>
      <div className="subscribe-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={() => onResume(resolved)}>{busy ? '恢復中…' : '恢復訂閱'}</button>
        <button type="button" className="text-button" onClick={onClose}>取消</button>
      </div>
    </>}
  </div>;
}

function SubscriptionList({ snapshot, policy, onChanged }: {
  snapshot: Snapshot | null;
  policy: ChannelSchedule | null;
  onChanged: (text: string, tone?: 'ok' | 'error') => void;
}) {
  const [checking, setChecking] = useState(false);
  const subscriptions = snapshot?.subscriptions ?? null;
  const times = snapshot ? checkTimes(snapshot.schedule) : null;
  const enabledCount = subscriptions?.filter((subscription) => subscription.enabled).length ?? 0;

  async function checkAll(): Promise<void> {
    setChecking(true);
    try {
      const submissions = await api.checkAllChannels();
      onChanged(`已開始檢查 ${submissions.length} 個訂閱。`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '無法開始檢查。', 'error');
    } finally {
      setChecking(false);
    }
  }

  return <section className="subscription-list" aria-label="已訂閱頻道" data-testid="subscription-list">
    <div className="subscription-list-heading">
      <h4>已訂閱頻道</h4>
      {times ? <span className="subscription-times" data-testid="subscription-times">上次檢查 {times.last}・下次檢查 {times.next}</span> : null}
      <button type="button" className="secondary-button compact" disabled={checking || enabledCount === 0} onClick={() => void checkAll()}>
        {checking ? '檢查中…' : '立即檢查'}
      </button>
    </div>
    {subscriptions === null ? <p className="job-empty">正在讀取…</p>
      : subscriptions.length === 0 ? <p className="job-empty">還沒有訂閱頻道。貼上頻道網址或 @handle 開始訂閱。</p>
        : <ul>{subscriptions.map((subscription) => <SubscriptionRow key={subscription.id} subscription={subscription} policy={policy} onChanged={onChanged} />)}</ul>}
  </section>;
}

function SubscriptionRow({ subscription, policy, onChanged }: {
  subscription: Subscription;
  policy: ChannelSchedule | null;
  onChanged: (text: string, tone?: 'ok' | 'error') => void;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const paused = subscription.status === 'paused';

  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    try {
      onChanged(await work());
    } catch (error) {
      onChanged(error instanceof Error ? error.message : '操作失敗，請稍後再試。', 'error');
    } finally {
      setBusy(false);
    }
  }

  return <li className={`subscription-row ${subscription.status}`} data-testid={`subscription-${subscription.id}`}>
    <div className="subscription-main">
      <span className="subscription-title" title={subscription.url}>{subscription.title}</span>
      <span className={`subscription-tag ${subscription.status}`}>{subscriptionStatusLabel(subscription)}</span>
      <button type="button" className="secondary-button compact" disabled={busy}
        onClick={() => void run(async () => {
          await api.setChannelEnabled(subscription.id, paused);
          return paused ? `已恢復「${subscription.title}」，開始補收。` : `已暫停「${subscription.title}」。`;
        })}>{paused ? '恢復' : '暫停'}</button>
      <button type="button" className="icon-button" aria-label={`移除訂閱 ${subscription.title}`} title="移除訂閱" disabled={busy}
        onClick={() => setConfirmingRemove(true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
      </button>
    </div>
    <p className="subscription-detail">{subscriptionDetail(subscription, policy)}</p>
    {confirmingRemove ? <div className="remove-confirm" role="group" aria-label="確認移除訂閱">
      <p>{removeConfirmation(subscription)}</p>
      <button type="button" className="danger-button" disabled={busy} onClick={() => void run(async () => {
        const { documentsKept } = await api.removeChannel(subscription.id);
        return `已移除「${subscription.title}」，保留 ${documentsKept} 份文件。`;
      })}>確認移除</button>
      <button type="button" className="text-button" onClick={() => setConfirmingRemove(false)}>取消</button>
    </div> : null}
  </li>;
}

function JobList({ jobs, loadError }: { jobs: CollectionJob[] | null; loadError: string | null }) {
  return <section className="job-list" aria-label="收集工作">
    <div className="job-list-heading"><h4>收集工作</h4>{loadError ? <span className="job-load-error" role="alert">{loadError}</span> : null}</div>
    {jobs === null ? <p className="job-empty">正在讀取…</p> : jobs.length === 0 ? <p className="job-empty">還沒有收集工作。</p>
      : <ul>{jobs.map((job) => <JobRow key={job.id} job={job} />)}</ul>}
  </section>;
}

function JobRow({ job }: { job: CollectionJob }) {
  const phase = jobPhaseLabel(job);
  const progress = jobProgressLabel(job);
  const result = jobResultLabel(job);
  const warning = job.state === 'completed' && job.result?.indexed === false;
  return <li className={`job-row ${job.state}`} data-testid={`job-${job.id}`}>
    <div className="job-main">
      <span className="job-kind">{jobKindLabel(job)}</span>
      <span className="job-title" title={job.source.url}>{jobTitle(job)}</span>
      <span className={`job-state ${job.state}`}>{jobStateLabel(job)}{phase ? `・${phase}` : ''}</span>
    </div>
    {progress ? <p className="job-detail">{progress}</p> : null}
    {result ? <p className={`job-detail ${warning || job.state !== 'completed' ? 'job-problem' : ''}`}>{result}</p> : null}
    {job.items && job.items.length > 0 ? <details className="job-items"><summary>查看影片（{job.items.length}）</summary><ul>
      {job.items.map((item) => <li key={item.sourceId}><span>{item.title}</span><span className={`job-state ${item.state}`}>{item.outcome === 'created' ? '新增' : item.outcome === 'existing' ? '已存在' : item.outcome === 'skipped' ? `略過・${skipReasonLabel(item.skipReason)}` : jobStateLabel({ ...job, state: item.state })}</span>{item.error ? <span className="job-problem">{item.error.message}</span> : null}</li>)}
    </ul></details> : null}
  </li>;
}
