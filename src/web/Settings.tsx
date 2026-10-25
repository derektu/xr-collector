import { useEffect, useRef, useState } from 'react';
import { api } from './api-client.js';
import { radioIndexForKey, themePreferences, type ThemePreference } from './app-shell.js';
import { SearchIndexCard } from './SearchIndexCard.js';
import { VaultLocationSection } from './VaultLocation.js';
import { BuildInfoCard } from './BuildInfoCard.js';
import { LoginStartup } from './LoginStartup.js';
import { AgentConnection } from './AgentConnection.js';

const themeLabels: Record<ThemePreference, string> = { system: '跟隨系統', dark: '深色', light: '淺色' };

/**
 * Device and Vault settings: Vault location with export and import, search index and appearance. Collection
 * settings belong to each source.
 */
export function Settings({ vaultPath, activeJobs, themePreference, onThemePreference, onChanged }: {
  vaultPath: string | null;
  activeJobs: number;
  themePreference: ThemePreference;
  onThemePreference: (preference: ThemePreference) => void;
  onChanged: (message: string) => void;
}) {
  const themeOptions = useRef<Array<HTMLButtonElement | null>>([]);
  const [counts, setCounts] = useState<{ documents: number; sources: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.documentSources(controller.signal), api.listSubscriptions(controller.signal)])
      .then(([documents, sources]) => setCounts({ documents: documents.total, sources: sources.subscriptions.length }))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return <>
    <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>設定</h1></div>
    <div className="settings-sections">
      <VaultLocationSection vaultPath={vaultPath} activeJobs={activeJobs} counts={counts} onChanged={onChanged} />
      <SearchIndexCard />
      <LoginStartup onChanged={onChanged} />
      <AgentConnection />
      <section className="settings-section" data-testid="settings-appearance">
        <h2>外觀</h2>
        {/* A radio group: one Tab stop on the chosen option, arrow keys and Home/End choose another. */}
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
      <BuildInfoCard />
    </div>
  </>;
}
