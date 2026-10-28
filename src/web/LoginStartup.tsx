import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoginStartupStatus } from '../core/types.js';
import { api } from './api-client.js';
import { createLatestRequest } from './latest-request.js';

export function LoginStartup({ onChanged }: { onChanged: (message: string) => void }) {
  const [status, setStatus] = useState<LoginStartupStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useMemo(createLatestRequest, []);
  const mounted = useRef(false);
  const updatePending = useRef(false);

  const refresh = useCallback(async (clearError = true) => {
    try {
      const result = await requests.run((signal) => api.getLoginStartup(signal));
      if (!result.current || !mounted.current) return;
      setStatus(result.value);
      if (clearError) setError(null);
    } catch (caught) {
      if (mounted.current && (caught as { name?: string }).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : '無法讀取登入自啟狀態。');
      }
    }
  }, [requests]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => { if (!updatePending.current) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      requests.cancel();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, requests]);

  const update = async (enabled: boolean) => {
    updatePending.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await requests.run((signal) => api.setLoginStartup(enabled, signal));
      if (!result.current || !mounted.current) return;
      setStatus(result.value);
      onChanged(enabled ? '已開啟登入自啟' : '已關閉登入自啟');
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught instanceof Error ? caught.message : '無法更新登入自啟。');
      await refresh(false);
    } finally {
      updatePending.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const unavailable = status?.supported === false;
  const routineStatus = status?.message === '已在登入電腦時自動啟動。' || status?.message === '登入自啟已關閉。';
  const message = pending ? '正在更新…' : error ?? (unavailable ? '僅限安裝版 App。'
    : !status ? '正在讀取…' : routineStatus ? null : status.message);
  return <section className="settings-section" data-testid="settings-login-startup">
    <h2>啟動與背景執行</h2>
    <div className="login-startup-control">
      <strong>登入電腦時自動啟動</strong>
      <label className="header-switch" data-testid="login-startup-switch">
        <input type="checkbox" aria-label="登入電腦時自動啟動" checked={status?.enabled ?? false} disabled={!status || pending || unavailable}
          onChange={(event) => void update(event.target.checked)} />
        <span className="switch" aria-hidden="true" />
      </label>
    </div>
    {message ? <p className={error ? 'setting-message error' : 'setting-message'} role={error ? 'alert' : 'status'} data-testid="login-startup-status">
      {message}
    </p> : null}
  </section>;
}
