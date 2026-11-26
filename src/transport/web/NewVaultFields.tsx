import type { ReactNode } from 'react';
import type { NewVaultCheck } from '../../shared/vault/vault-types.js';
import { api } from './api-client.js';
import { useDebouncedValue } from './infra/timing.js';
import { useRead } from './infra/use-read.js';

const CHECK_DELAY_MS = 250;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '無法檢查這個位置，請稍後再試。';
}

export function useNewVaultCheck(location: string, name: string, enabled = true): { check: NewVaultCheck | null; checking: boolean } {
  const checkedLocation = useDebouncedValue(location, CHECK_DELAY_MS);
  const checkedName = useDebouncedValue(name, CHECK_DELAY_MS);
  const settled = location === checkedLocation && name === checkedName;
  const read = useRead((signal) => api.checkNewVault(checkedLocation, checkedName, signal), [checkedLocation, checkedName], { enabled: enabled && settled });
  const check = read.error ? { path: null, problem: errorText(read.error) } : read.value;
  const checking = !enabled || !settled || read.pending;
  return { check, checking };
}

export function failureNotInPreview(failure: string | null | undefined, check: NewVaultCheck | null): string | null {
  return failure && failure !== check?.problem ? failure : null;
}

export function ListRow({ title, detail, children, testId, field }: { title: string; detail?: ReactNode; children?: ReactNode; testId?: string; field?: boolean }) {
  return <div className={field ? 'ob-row ob-field' : 'ob-row'} data-testid={testId}>
    <div className="ob-row-text"><strong>{title}</strong>{detail ? <p>{detail}</p> : null}</div>
    {children}
  </div>;
}

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
    <p className={`ob-preview ${check?.problem ? 'error' : ''}`} aria-live="polite" data-testid="new-vault-preview"
      data-path={check && !check.problem ? check.path ?? undefined : undefined} data-problem={check?.problem ? 'true' : undefined}>
      {check?.problem ?? (check?.path ? <>知識庫位置：<code>{check.path}</code></> : checking ? '正在檢查…' : '')}
    </p>
  </>;
}
