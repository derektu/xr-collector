import { useEffect, useState, type ReactNode } from 'react';
import type { NewVaultCheck } from '../core/types.js';
import { api } from './api-client.js';

const CHECK_DELAY_MS = 250;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '無法檢查這個位置，請稍後再試。';
}

/**
 * Checks the new Vault folder `name` in `location` after a pause in typing; a newer input aborts the
 * older check. `ready` is true only while the latest check says the folder can be created. Nothing is
 * checked while `enabled` is false.
 */
export function useNewVaultCheck(location: string, name: string, enabled = true): { check: NewVaultCheck | null; checking: boolean; ready: boolean } {
  const [check, setCheck] = useState<NewVaultCheck | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    setChecking(true);
    if (!enabled) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.checkNewVault(location, name, controller.signal)
        .then((result) => { setCheck(result); setChecking(false); })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setCheck({ path: null, problem: errorText(error) });
          setChecking(false);
        });
    }, CHECK_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [location, name, enabled]);
  return { check, checking, ready: !checking && !!check?.path && !check.problem };
}

/**
 * One row of an `ob-list`: a title with an optional line under it, and its control on the right.
 * A `field` row is a form field: a short label with its control filling the rest, left-aligned.
 */
export function ListRow({ title, detail, children, testId, field }: { title: string; detail?: ReactNode; children?: ReactNode; testId?: string; field?: boolean }) {
  return <div className={field ? 'ob-row ob-field' : 'ob-row'} data-testid={testId}>
    <div className="ob-row-text"><strong>{title}</strong>{detail ? <p>{detail}</p> : null}</div>
    {children}
  </div>;
}

/**
 * The name and location of a new Vault, with the folder it creates or why it cannot. `onChooseLocation`
 * opens the desktop folder picker; without it the location is typed, as in a browser session.
 * `before` adds rows above the name, such as the export file a Vault is created from.
 */
export function NewVaultFields({ name, location, check, checking, onName, onLocation, onChooseLocation, busy, before }: {
  name: string;
  location: string;
  check: NewVaultCheck | null;
  checking: boolean;
  onName: (name: string) => void;
  onLocation: (location: string) => void;
  onChooseLocation?: () => void;
  busy: boolean;
  before?: ReactNode;
}) {
  return <>
    <div className="ob-list">
      {before}
      <ListRow title="名稱" field>
        <div className="ob-control"><input className="url-input" value={name} spellCheck={false} aria-label="名稱" disabled={busy}
          onChange={(event) => onName(event.target.value)} data-testid="new-vault-name" /></div>
      </ListRow>
      <ListRow title="位置" field>
        <div className="ob-control">
          {onChooseLocation ? <>
            <span className="ob-path" title={location} data-testid="new-vault-location">{location}</span>
            <button type="button" className="button" disabled={busy} onClick={onChooseLocation} data-testid="new-vault-choose-location">選擇位置</button>
          </> : <input className="url-input ob-path-input" value={location} spellCheck={false} aria-label="位置" disabled={busy}
            onChange={(event) => onLocation(event.target.value)} data-testid="new-vault-location-input" />}
        </div>
      </ListRow>
    </div>
    <p className={`ob-preview ${check?.problem ? 'error' : ''}`} aria-live="polite" data-testid="new-vault-preview">
      {check?.problem ?? (check?.path ? <>知識庫位置：<code>{check.path}</code></> : checking ? '正在檢查…' : '')}
    </p>
  </>;
}
