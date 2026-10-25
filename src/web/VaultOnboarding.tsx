import { useEffect, useRef, useState } from 'react';
import type { VaultSetupResult, VaultSetupStatus } from '../core/types.js';
import { BuildInfoCard } from './BuildInfoCard.js';
import { api, ApiError } from './api-client.js';
import { ImportDone, ImportOnboarding, Onboarding, type VaultAction, type VaultInspection } from './Onboarding.js';

/** How often a waiting Onboarding checks whether an Agent finished setup through the API. */
const STATUS_POLL_MS = 3000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '發生未預期的錯誤，請重試。';
}

/**
 * Connects the Onboarding screens to the Vault setup API and the desktop pickers: create or open a
 * Vault, or create one from an export file and decide on automatic collection before entering.
 */
export function VaultOnboarding({ status, onStatus, onReady }: {
  status: VaultSetupStatus;
  onStatus: (status: VaultSetupStatus) => void;
  onReady: (result: VaultSetupResult) => void;
}) {
  const [inspection, setInspection] = useState<VaultInspection>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<'choose' | 'import'>('choose');
  const [packagePath, setPackagePath] = useState<string | null>(null);
  const [imported, setImported] = useState<VaultSetupResult | null>(null);
  const sequence = useRef(0);
  const desktop = window.xrCollectorDesktop;

  useEffect(() => {
    if (busy || imported) return undefined;
    const timer = window.setInterval(() => {
      void api.getVaultSetup().then((next) => { if (next.state === 'ready') onStatus(next); }).catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, imported, onStatus]);

  async function inspect(path: string, clearError = true): Promise<void> {
    const current = ++sequence.current;
    if (clearError) setError(undefined);
    setInspection({ kind: 'inspecting', path });
    try {
      const result = await api.inspectVault(path);
      if (current !== sequence.current) return;
      setInspection(result.kind === 'invalid' ? { kind: 'invalid', path: result.path, reason: result.reason }
        : result.kind === 'existing' ? { kind: 'existing', path: result.path, documentCount: result.documentCount }
          : { kind: 'empty', path: result.path, exists: result.exists });
    } catch (failure) {
      if (current === sequence.current) setInspection({ kind: 'invalid', path, reason: errorMessage(failure) });
    }
  }

  async function chooseDirectory(): Promise<void> {
    if (!desktop) return;
    const selected = inspection.kind === 'none' ? null : inspection.path;
    try {
      const path = await desktop.chooseDirectory(selected ?? status.suggestedPath);
      if (path) await inspect(path);
    } catch (failure) {
      setError(`無法開啟目錄選擇視窗：${errorMessage(failure)}`);
    }
  }

  async function continueWith(action: VaultAction, path: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      onReady(await api.setupVault(action, path));
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'vault_already_set') {
        onStatus(await api.getVaultSetup());
        return;
      }
      setError(errorMessage(failure));
      // The directory may have changed underneath us; show what it looks like now.
      await inspect(path, false);
    } finally {
      setBusy(false);
    }
  }

  async function choosePackage(): Promise<void> {
    if (!desktop) return;
    try {
      const file = await desktop.chooseImportFile();
      if (file) { setPackagePath(file); setError(undefined); }
    } catch (failure) {
      setError(`無法開啟檔案選擇視窗：${errorMessage(failure)}`);
    }
  }

  async function importFrom(file: string, folder: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setImported(await api.setupVault('import', folder, file));
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'vault_already_set') {
        onStatus(await api.getVaultSetup());
        return;
      }
      setError(errorMessage(failure));
      await inspect(folder, false);
    } finally {
      setBusy(false);
    }
  }

  let screen;
  if (imported) {
    screen = <ImportDone vaultPath={imported.vault.vaultPath ?? ''} documentCount={imported.documentCount} onEnter={() => onReady(imported)} />;
  } else if (mode === 'import') {
    screen = <ImportOnboarding
      packagePath={packagePath}
      inspection={inspection}
      suggestedPath={status.suggestedPath}
      busy={busy}
      {...(error ? { error } : {})}
      pathEntry={desktop ? 'dialog' : 'manual'}
      onChoosePackage={() => void choosePackage()}
      onSubmitPackage={(path) => { setPackagePath(path); setError(undefined); }}
      onChooseDirectory={() => void chooseDirectory()}
      onSubmitPath={(path) => void inspect(path)}
      onImport={(file, folder) => void importFrom(file, folder)}
      onBack={() => { setMode('choose'); setError(undefined); }}
    />;
  } else {
    screen = <Onboarding
      inspection={inspection}
      suggestedPath={status.suggestedPath}
      {...(status.failure ? { originalFailure: status.failure } : {})}
      busy={busy}
      {...(error ? { error } : {})}
      pathEntry={desktop ? 'dialog' : 'manual'}
      onChooseDirectory={() => void chooseDirectory()}
      onSubmitPath={(path) => void inspect(path)}
      onContinue={(action, path) => void continueWith(action, path)}
      onImport={() => { setMode('import'); setError(undefined); }}
    />;
  }
  return <div className="onboarding-with-build-info">{screen}<BuildInfoCard compact /></div>;
}
