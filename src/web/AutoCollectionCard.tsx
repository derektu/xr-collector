import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackfillWindow, ChannelSchedule, CollectionPolicy } from '../core/types.js';
import { api } from './api-client.js';
import { checkTimes, intervalChoices, limitChoices, windowChoices } from './subscription-presentation.js';

const SAVED_NOTICE_MS = 2000;
const REFRESH_MS = 15_000;

type Patch = Partial<CollectionPolicy & { enabled: boolean }>;

/**
 * Settings section for the Global collection policy shared by every subscription. Each change saves
 * at once; a failed save shows why and returns the controls to the stored values.
 */
export function AutoCollectionCard() {
  const [schedule, setSchedule] = useState<ChannelSchedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{ tone: 'saving' | 'saved' | 'error'; text: string } | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setSchedule(await api.getChannelSchedule());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '無法讀取自動收集設定。');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { clearInterval(timer); clearTimeout(savedTimer.current); };
  }, [load]);

  async function save(patch: Patch): Promise<void> {
    clearTimeout(savedTimer.current);
    setSchedule((current) => current ? { ...current, ...patch } : current);
    setSaveState({ tone: 'saving', text: '儲存中…' });
    try {
      setSchedule(await api.updateChannelSchedule(patch));
      setSaveState({ tone: 'saved', text: '已儲存' });
      savedTimer.current = setTimeout(() => setSaveState(null), SAVED_NOTICE_MS);
    } catch (error) {
      setSaveState({ tone: 'error', text: error instanceof Error ? error.message : '儲存失敗，請稍後再試。' });
      await load();
    }
  }

  const times = schedule ? checkTimes(schedule) : null;
  return <section className="settings-section auto-collection-card" data-testid="settings-auto-collection">
    <div className="setting-card-heading">
      <h2>自動收集</h2>
      {saveState ? <span className={`save-state ${saveState.tone}`} role={saveState.tone === 'error' ? 'alert' : 'status'}>{saveState.text}</span> : null}
    </div>
    {loadError ? <p className="documents-error">{loadError}</p> : null}
    {schedule && times ? <>
      <label className="switch-row">
        <input type="checkbox" role="switch" checked={schedule.enabled} onChange={(event) => void save({ enabled: event.target.checked })} />
        <span className="switch" aria-hidden="true" />
        <span>{schedule.enabled ? '定時檢查已開啟' : '自動收集已暫停'}</span>
      </label>
      {!schedule.enabled ? <p className="index-problem">訂閱不會定時檢查新內容；新訂閱的首次收集與「立即檢查」照常執行。</p> : null}
      <div className="policy-row">
        <label htmlFor="policy-interval">檢查頻率</label>
        <select id="policy-interval" value={schedule.intervalMinutes} onChange={(event) => void save({ intervalMinutes: Number(event.target.value) })}>
          {intervalChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </div>
      <div className="policy-row">
        <span id="policy-backfill-label">補收範圍</span>
        <span className="policy-sentence" role="group" aria-labelledby="policy-backfill-label">
          最近
          <select aria-label="補收時間範圍" value={schedule.backfillWindow} onChange={(event) => void save({ backfillWindow: event.target.value as BackfillWindow })}>
            {windowChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
          內最新的最多
          <select aria-label="補收則數" value={schedule.backfillMaxItems} onChange={(event) => void save({ backfillMaxItems: Number(event.target.value) })}>
            {limitChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </span>
      </div>
      <p className="hint">所有訂閱共用這些設定。補收範圍用於新訂閱的首次收集、恢復訂閱，以及服務重新啟動或長時間沒有檢查之後；修改補收範圍不會重新回溯既有頻道。持續運作時，每次檢查都會收完上次之後的新內容。</p>
      <p className="policy-times" data-testid="auto-collection-times">下次檢查：{times.next}<br />上次檢查：{times.last}</p>
    </> : !loadError ? <p className="loading">正在讀取…</p> : null}
  </section>;
}
