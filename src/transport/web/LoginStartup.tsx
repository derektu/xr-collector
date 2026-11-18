import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api-client.js';
import { LoginStartupControl, loginStartupNote, type LoginStartupState } from './login-startup-control.js';

export function LoginStartup({ onChanged }: { onChanged: (message: string) => void }) {
  const [{ status, pending, error }, setState] = useState<LoginStartupState>({ status: null, pending: false, error: null });
  const announce = useRef(onChanged);
  announce.current = onChanged;
  const control = useMemo(() => new LoginStartupControl({
    read: (signal) => api.getLoginStartup(signal),
    write: (enabled, signal) => api.setLoginStartup(enabled, signal),
  }, setState, (enabled) => announce.current(enabled ? '已開啟登入自啟' : '已關閉登入自啟')), []);

  useEffect(() => {
    void control.start();
    const onFocus = () => { void control.focus(); };
    window.addEventListener('focus', onFocus);
    return () => {
      control.close();
      window.removeEventListener('focus', onFocus);
    };
  }, [control]);
  const update = (enabled: boolean) => control.write(enabled);

  const unavailable = status?.supported === false;
  const note = loginStartupNote({ status, pending, error });
  const message = !note ? null : 'message' in note ? note.message
    : note.kind === 'pending' ? '正在更新…' : note.kind === 'loading' ? '正在讀取…' : '僅限安裝版 App。';
  return <section className="settings-section" data-testid="settings-login-startup"
    data-state={status ? status.state : 'loading'} data-supported={status ? String(status.supported) : undefined} data-error={error ? 'true' : undefined}>
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
