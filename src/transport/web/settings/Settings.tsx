import { api } from '../api/api-client.js';
import { themePreferences, type ThemePreference } from '../shell/app-shell.js';
import { SegmentedChoice } from '../shell/SegmentedChoice.js';
import { SearchIndexCard } from './SearchIndexCard.js';
import { VaultLocationSection } from '../vault/VaultLocation.js';
import { BuildInfoCard } from './BuildInfoCard.js';
import { LoginStartup } from './LoginStartup.js';
import { AgentConnection } from './AgentConnection.js';
import { useLiveRead } from '../infra/use-changes.js';
import type { DeviceUpdateStatus } from '../../../shared/api/update-types.js';

const themeLabels: Record<ThemePreference, string> = { system: '跟隨系統', dark: '深色', light: '淺色' };
const themeOptions = themePreferences.map((value) => ({ value, label: themeLabels[value] }));

export function Settings({ vaultPath, themePreference, update, onUpdate, onThemePreference, onNotice }: {
  vaultPath: string | null;
  themePreference: ThemePreference;
  update: DeviceUpdateStatus | null;
  onUpdate: (status: DeviceUpdateStatus) => void;
  onThemePreference: (preference: ThemePreference) => void;
  onNotice: (message: string) => void;
}) {
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
        <SegmentedChoice options={themeOptions} value={themePreference} onChange={onThemePreference} label="主題" />
      </section>
      <BuildInfoCard update={update} onUpdate={onUpdate} />
    </div>
  </>;
}
