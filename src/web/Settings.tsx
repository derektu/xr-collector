import { useEffect, useState } from 'react';
import { api } from './api-client.js';
import type { Theme } from './app-shell.js';
import { SearchIndexCard } from './SearchIndexCard.js';

/** Device and Vault settings: Vault location, search index and appearance. Collection settings belong to each source. */
export function Settings({ vaultPath, theme, themeBusy, onTheme }: {
  vaultPath: string | null;
  theme: Theme;
  themeBusy: boolean;
  onTheme: (theme: Theme) => void;
}) {
  const [counts, setCounts] = useState<{ documents: number; sources: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.documentSources(controller.signal), api.listSources(controller.signal)])
      .then(([documents, sources]) => setCounts({ documents: documents.total, sources: sources.sources.length }))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return <>
    <div className="page-header"><h1 className="page-title" tabIndex={-1} data-page-heading>設定</h1></div>
    <div className="settings-sections">
      <section className="settings-section" data-testid="settings-vault">
        <h2>知識庫</h2>
        <code className="setting-path">{vaultPath}</code>
        {counts ? <p className="hint">{counts.documents} 份文件・{counts.sources} 個來源</p> : null}
      </section>
      <SearchIndexCard />
      <section className="settings-section" data-testid="settings-appearance">
        <h2>外觀</h2>
        <div className="segmented" role="radiogroup" aria-label="主題">
          {(['dark', 'light'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={theme === value}
            className={theme === value ? 'active' : undefined} disabled={themeBusy} onClick={() => onTheme(value)}>{value === 'dark' ? '深色' : '淺色'}</button>)}
        </div>
      </section>
    </div>
  </>;
}
