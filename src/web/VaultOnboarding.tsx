import { useEffect, useState, type ReactElement } from 'react';
import type { PackageDescription, VaultSetupRequest, VaultSetupResult, VaultSetupStatus } from '../core/types.js';
import { BuildInfoCard } from './BuildInfoCard.js';
import { api, ApiError } from './api-client.js';
import { useLiveRead } from './use-changes.js';
import { NewVaultFields, useNewVaultCheck } from './NewVaultFields.js';
import { OnboardingHome, OnboardingStep, PackageRow } from './Onboarding.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '發生未預期的錯誤，請重試。';
}

/**
 * Connects the Onboarding screens to the Vault setup API and the desktop pickers: create a new
 * Vault, open an existing one, or create one from an export file.
 */
export function VaultOnboarding({ status, onStatus, onReady }: {
  status: VaultSetupStatus;
  onStatus: (status: VaultSetupStatus) => void;
  onReady: (result: VaultSetupResult) => void;
}) {
  const [screen, setScreen] = useState<'home' | 'create' | 'import'>('home');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState(status.newVault.name);
  const [location, setLocation] = useState(status.newVault.location);
  const [described, setDescribed] = useState<PackageDescription | null>(null);
  const { check, checking, ready } = useNewVaultCheck(location, name, screen !== 'home');
  const desktop = window.xrCollectorDesktop;
  const pathEntry = desktop ? 'dialog' : 'manual';

  // An Agent can finish setup through the API while Onboarding waits.
  const { value: setup } = useLiveRead(['vaultSetup'], (signal) => api.getVaultSetup(signal), [], { enabled: !busy });
  useEffect(() => {
    if (!busy && setup?.state === 'ready') onStatus(setup);
  }, [setup, busy, onStatus]);

  async function run(request: VaultSetupRequest): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      onReady(await api.setupVault(request));
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'vault_already_set') {
        onStatus(await api.getVaultSetup());
        return;
      }
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function open(path?: string): Promise<void> {
    setError(undefined);
    let chosen = path;
    if (!chosen && desktop) {
      try {
        chosen = await desktop.chooseVault(status.newVault.location) ?? undefined;
      } catch (failure) {
        setError(`無法開啟資料夾選擇視窗：${errorMessage(failure)}`);
        return;
      }
    }
    if (chosen) await run({ action: 'open', path: chosen });
  }

  async function chooseLocation(): Promise<void> {
    try {
      const chosen = await desktop?.chooseVaultLocation(location);
      if (chosen) setLocation(chosen);
    } catch (failure) {
      setError(`無法開啟資料夾選擇視窗：${errorMessage(failure)}`);
    }
  }

  /** Reads the export file at `path`, or one the desktop picker returns; true once one is read. */
  async function readPackage(path?: string): Promise<boolean> {
    setError(undefined);
    try {
      const file = path ?? await desktop?.chooseImportFile();
      if (!file) return false;
      const next = await api.describePackage(file);
      setDescribed(next);
      setName(next.folderName);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
  }

  async function fromExport(): Promise<void> {
    if (!desktop || await readPackage()) {
      setLocation(status.newVault.location);
      setScreen('import');
    }
  }

  function back(): void {
    setScreen('home');
    setError(undefined);
    setDescribed(null);
    setName(status.newVault.name);
    setLocation(status.newVault.location);
  }

  const fields = (before?: ReactElement) => <NewVaultFields name={name} location={location} check={check} checking={checking} busy={busy}
    onName={setName} onLocation={setLocation} {...(desktop ? { onChooseLocation: () => void chooseLocation() } : {})} {...(before ? { before } : {})} />;
  const failure = error ? <p className="ob-error" role="alert" data-testid="onboarding-error">{error}</p> : null;

  let content;
  if (screen === 'create') {
    content = <OnboardingStep title="建立新的知識庫" busy={busy} onBack={back} testId="onboarding-create-form">
      {fields()}
      <div className="ob-actions"><button type="button" className="button primary" disabled={busy || !ready}
        onClick={() => void run({ action: 'create', location, name })} data-testid="onboarding-create-confirm">{busy ? '正在建立…' : '建立'}</button></div>
      {failure}
    </OnboardingStep>;
  } else if (screen === 'import') {
    content = <OnboardingStep title="從匯出檔建立知識庫" busy={busy} onBack={back} testId="onboarding-import-form">
      {fields(<PackageRow described={described} busy={busy} pathEntry={pathEntry}
        onChoose={() => void readPackage()} onSubmitPath={(path) => void readPackage(path)} />)}
      <div className="ob-actions"><button type="button" className="button primary" disabled={busy || !ready || !described}
        onClick={() => described && void run({ action: 'import', location, name, packagePath: described.path })}
        data-testid="onboarding-import-confirm">{busy ? '正在匯入…' : '建立並匯入'}</button></div>
      {failure}
    </OnboardingStep>;
  } else {
    content = <OnboardingHome
      {...(status.failure ? { originalFailure: status.failure } : {})}
      busy={busy}
      {...(error ? { error } : {})}
      pathEntry={pathEntry}
      onCreate={() => { setError(undefined); setScreen('create'); }}
      onOpen={(path) => void open(path)}
      onFromExport={() => void fromExport()}
    />;
  }
  return <div className="onboarding-with-build-info">{content}<BuildInfoCard compact /></div>;
}
