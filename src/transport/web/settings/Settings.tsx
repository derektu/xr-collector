import { useRef } from 'react';
import { api } from '../api/api-client.js';
import { radioIndexForKey, themePreferences, type ThemePreference } from '../shell/app-shell.js';
import { SearchIndexCard } from './SearchIndexCard.js';
import { VaultLocationSection } from '../vault/VaultLocation.js';
import { BuildInfoCard } from './BuildInfoCard.js';
import { LoginStartup } from './LoginStartup.js';
import { AgentConnection } from './AgentConnection.js';
import { useLiveRead } from '../infra/use-changes.js';
import type { DeviceUpdateStatus } from '../../../shared/api/update-types.js';

const themeLabels: Record<ThemePreference, string> = { system: '跟隨系統', dark: '深色', light: '淺色' };

export function Settings({ vaultPath, themePreference, update, onUpdate, onThemePreference, onNotice }: {
  vaultPath: string | null;
  themePreference: ThemePreference;
  update: DeviceUpdateStatus | null;
  onUpdate: (status: DeviceUpdateStatus) => void;
  onThemePreference: (preference: ThemePreference) => void;
  onNotice: (message: string) => void;
}) {
  const themeOptions = useRef<Array<HTMLButtonElement | null>>([]);
  const { value: counts } = useLiveRead(['documents'], (signal) => Promise.all([api.documentSources(signal), api.listSubscriptions(signal)])
    .then(([documents, sources]) => ({ documents: documents.total, sources: sources.subscriptions.length })), []);

  return <>
    <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>設定</h1></div>
    <div className="settings-sections">
      <VaultLocationSection vaultPath={vaultPath} counts={counts} onNotice={onNotice} />
      <SearchIndexCard />
      <LoginStartup onNotice={onNotice} />
      <AgentConnection />
      <section className="settings-section" data-testid="settings-appearance">
        <h2>外觀</h2>
        <div className="segmented" role="radiogroup" aria-label="主題" onKeyDown={(event) => {
          const next = radioIndexForKey(event.key, themePreferences.indexOf(themePreference), themePreferences.length);
          if (next === null) return;
          event.preventDefault();
          onThemePreference(themePreferences[next]!);
          themeOptions.current[next]?.focus();
        }}>
          {themePreferences.map((value, index) => <button key={value} ref={(element) => { themeOptions.current[index] = element; }} type="button" role="radio"
            aria-checked={themePreference === value} tabIndex={themePreference === value ? 0 : -1} className={themePreference === value ? 'active' : undefined}
            onClick={() => onThemePreference(value)}>{themeLabels[value]}</button>)}
        </div>
      </section>
      <BuildInfoCard update={update} onUpdate={onUpdate} />
    </div>
  </>;
}
