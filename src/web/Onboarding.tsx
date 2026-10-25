import { useState, type FormEvent } from 'react';
import './onboarding.css';
import { AgentConnectionHelp } from './AgentConnectionHelp.js';
import { AgentConnection } from './AgentConnection.js';

export type VaultInspection =
  | { kind: 'none' }
  | { kind: 'inspecting'; path: string }
  | { kind: 'empty'; path: string; exists?: boolean }
  | { kind: 'existing'; path: string; documentCount?: number }
  | { kind: 'invalid'; path: string; reason: string };

export type VaultAction = 'create' | 'open';

export interface OnboardingProps {
  inspection: VaultInspection;
  suggestedPath: string;
  originalFailure?: { path: string; reason: string };
  busy?: boolean;
  /** Why the last create or open request failed; the selection stays so the user can retry. */
  error?: string;
  /** `dialog` uses the desktop folder picker; `manual` lets a browser session type a host path. */
  pathEntry?: 'dialog' | 'manual';
  onChooseDirectory: () => void;
  onSubmitPath?: (path: string) => void;
  onContinue: (action: VaultAction, path: string) => void;
  /** Switches to creating the Vault from an export file. */
  onImport?: () => void;
}

function FolderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 6.75A1.75 1.75 0 0 1 5.5 5h4l2 2h7A1.75 1.75 0 0 1 20.25 8.75v8.5A1.75 1.75 0 0 1 18.5 19h-13a1.75 1.75 0 0 1-1.75-1.75V6.75Z" /></svg>;
}

function inspectionPresentation(inspection: VaultInspection): { label: string; detail: string; tone: string; action?: VaultAction } {
  if (inspection.kind === 'inspecting') return { label: '正在檢查', detail: '正在確認這個目錄是否可以作為知識庫…', tone: 'checking' };
  if (inspection.kind === 'empty') return { label: '可建立', detail: inspection.exists === false
    ? '這個目錄還不存在，建立知識庫時會一併建立。' : '這是空目錄，可以在這裡建立新的知識庫。', tone: 'ready', action: 'create' };
  if (inspection.kind === 'existing') {
    const documents = inspection.documentCount === undefined ? '' : `，包含 ${inspection.documentCount} 份文件`;
    return { label: '已找到知識庫', detail: `此目錄包含可開啟的知識庫${documents}。`, tone: 'ready', action: 'open' };
  }
  if (inspection.kind === 'invalid') return { label: '無法使用', detail: inspection.reason, tone: 'error' };
  return { label: '尚未選擇', detail: '選擇一個空目錄，或已經存在的 XR Collector 知識庫。', tone: 'neutral' };
}

export function Onboarding({ inspection, suggestedPath, originalFailure, busy = false, error, pathEntry = 'dialog', onChooseDirectory, onSubmitPath, onContinue, onImport }: OnboardingProps) {
  const [typedPath, setTypedPath] = useState('');
  const [agentOpen, setAgentOpen] = useState(false);
  const presentation = inspectionPresentation(inspection);
  const selectedPath = inspection.kind === 'none' ? null : inspection.path;
  const disabled = busy || !presentation.action;
  const primaryLabel = presentation.action === 'open' ? '開啟知識庫' : '建立知識庫';

  return <div className="onboarding-screen">
    <header className="onboarding-header">
      <div className="onboarding-brand"><span className="brand-mark" aria-hidden="true">XR</span><span>XR Collector</span></div>
    </header>
    <main className="onboarding-main">
      <section className="onboarding-card" aria-labelledby="onboarding-title">
        <p className="eyebrow">開始使用</p>
        <div className="onboarding-title-line"><h1 id="onboarding-title">選擇知識庫位置</h1><span className="onboarding-agent-label">
          <button type="button" aria-expanded={agentOpen} aria-controls="onboarding-agent-panel" onClick={() => setAgentOpen((value) => !value)}>AI 助理連線</button>
          <AgentConnectionHelp onboarding /></span></div>
        <p className="onboarding-intro">收集的文件會保存在所選的目錄中，方便你自行備份與管理。</p>
        {agentOpen ? <div id="onboarding-agent-panel" data-testid="onboarding-agent-panel"><AgentConnection /></div> : null}

        {originalFailure ? <div className="vault-warning" role="alert">
          <span className="vault-warning-icon" aria-hidden="true">!</span>
          <div><strong>原知識庫無法開啟</strong><p>{originalFailure.reason}</p><code>{originalFailure.path}</code></div>
        </div> : null}

        <div className="directory-heading"><span id="vault-directory-label">知識庫目錄</span><span className={`directory-status ${presentation.tone}`}>{presentation.label}</span></div>
        {pathEntry === 'manual' ? <form className="directory-control" aria-labelledby="vault-directory-label" onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (typedPath.trim()) onSubmitPath?.(typedPath.trim());
        }}>
          <span className="directory-icon"><FolderIcon /></span>
          <input className="directory-input" aria-labelledby="vault-directory-label" value={typedPath} placeholder={suggestedPath} spellCheck={false} onChange={(event) => setTypedPath(event.target.value)} />
          <button className="choose-directory" type="submit" disabled={busy || inspection.kind === 'inspecting' || !typedPath.trim()}>檢查目錄</button>
        </form> : <div className="directory-control" aria-labelledby="vault-directory-label">
          <span className="directory-icon"><FolderIcon /></span>
          <span className={`directory-path ${selectedPath ? '' : 'directory-path-empty'}`}>{selectedPath ?? '尚未選擇目錄'}</span>
          <button className="choose-directory" type="button" onClick={onChooseDirectory} disabled={busy || inspection.kind === 'inspecting'}>選擇目錄</button>
        </div>}
        <p className={`directory-detail ${presentation.tone}`} aria-live="polite">{presentation.detail}</p>
        {inspection.kind === 'none' ? <p className="suggested-path">建議位置：<code>{suggestedPath}</code></p> : null}

        <button className="onboarding-primary" type="button" disabled={disabled} onClick={() => {
          if (presentation.action && selectedPath) onContinue(presentation.action, selectedPath);
        }}>{busy ? '處理中…' : primaryLabel}</button>
        {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
        {onImport ? <button className="onboarding-secondary" type="button" disabled={busy} onClick={onImport} data-testid="onboarding-import">
          從匯出檔匯入…</button> : null}
        <p className="onboarding-footnote">XR Collector 只會在你確認後建立或開啟知識庫。</p>
      </section>
    </main>
  </div>;
}

export interface ImportOnboardingProps {
  packagePath: string | null;
  /** The folder the new Vault goes in; it must be missing or empty. */
  inspection: VaultInspection;
  suggestedPath: string;
  busy: boolean;
  error?: string;
  pathEntry: 'dialog' | 'manual';
  onChoosePackage: () => void;
  onSubmitPackage: (path: string) => void;
  onChooseDirectory: () => void;
  onSubmitPath: (path: string) => void;
  onImport: (packagePath: string, folder: string) => void;
  onBack: () => void;
}

function FileIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.75h7l4 4v12.5H7Z" /><path d="M14 3.75v4h4" /></svg>;
}

/**
 * Onboarding for a machine that has no Vault yet while another machine has one: choose that
 * machine's export file and where the new Vault goes, and the Vault is created from the file.
 */
export function ImportOnboarding({
  packagePath, inspection, suggestedPath, busy, error, pathEntry, onChoosePackage, onSubmitPackage, onChooseDirectory, onSubmitPath, onImport, onBack,
}: ImportOnboardingProps) {
  const [typedPackage, setTypedPackage] = useState('');
  const [typedPath, setTypedPath] = useState('');
  const folder = inspection.kind === 'none' ? null : inspection.path;
  const folderState = inspection.kind === 'empty' ? { label: '可建立', tone: 'ready', detail: '知識庫會建立在這裡。' }
    : inspection.kind === 'existing' ? { label: '無法使用', tone: 'error', detail: '這裡已經是知識庫，請選空資料夾。' }
      : inspection.kind === 'invalid' ? { label: '無法使用', tone: 'error', detail: inspection.reason }
        : inspection.kind === 'inspecting' ? { label: '正在檢查', tone: 'checking', detail: '正在確認這個目錄…' }
          : { label: '尚未選擇', tone: 'neutral', detail: '選擇不存在或空的資料夾。' };
  const ready = !!packagePath && inspection.kind === 'empty' && !busy;

  return <div className="onboarding-screen">
    <header className="onboarding-header">
      <div className="onboarding-brand"><span className="brand-mark" aria-hidden="true">XR</span><span>XR Collector</span></div>
    </header>
    <main className="onboarding-main">
      <section className="onboarding-card" aria-labelledby="onboarding-import-title" data-testid="onboarding-import-card">
        <p className="eyebrow">開始使用</p>
        <h1 id="onboarding-import-title">從匯出檔建立知識庫</h1>

        <div className="directory-heading"><span id="import-package-label">匯出檔</span>
          <span className={`directory-status ${packagePath ? 'ready' : 'neutral'}`}>{packagePath ? '已選擇' : '尚未選擇'}</span></div>
        {pathEntry === 'manual' ? <form className="directory-control" aria-labelledby="import-package-label" onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (typedPackage.trim()) onSubmitPackage(typedPackage.trim());
        }}>
          <span className="directory-icon"><FileIcon /></span>
          <input className="directory-input" aria-labelledby="import-package-label" value={typedPackage} placeholder="/完整路徑/XR Collector 匯出 2026-10-19.zip"
            spellCheck={false} onChange={(event) => setTypedPackage(event.target.value)} data-testid="onboarding-package-input" />
          <button className="choose-directory" type="submit" disabled={busy || !typedPackage.trim()}>使用這個檔案</button>
        </form> : <div className="directory-control" aria-labelledby="import-package-label">
          <span className="directory-icon"><FileIcon /></span>
          <span className={`directory-path ${packagePath ? '' : 'directory-path-empty'}`}>{packagePath ?? '尚未選擇匯出檔'}</span>
          <button className="choose-directory" type="button" onClick={onChoosePackage} disabled={busy}>選擇匯出檔</button>
        </div>}
        <p className="directory-detail" data-testid="onboarding-package-path">{packagePath && pathEntry === 'manual' ? packagePath : ''}</p>

        <div className="directory-heading"><span id="import-folder-label">知識庫目錄</span><span className={`directory-status ${folderState.tone}`}>{folderState.label}</span></div>
        {pathEntry === 'manual' ? <form className="directory-control" aria-labelledby="import-folder-label" onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (typedPath.trim()) onSubmitPath(typedPath.trim());
        }}>
          <span className="directory-icon"><FolderIcon /></span>
          <input className="directory-input" aria-labelledby="import-folder-label" value={typedPath} placeholder={suggestedPath} spellCheck={false}
            onChange={(event) => setTypedPath(event.target.value)} data-testid="onboarding-folder-input" />
          <button className="choose-directory" type="submit" disabled={busy || inspection.kind === 'inspecting' || !typedPath.trim()}>檢查目錄</button>
        </form> : <div className="directory-control" aria-labelledby="import-folder-label">
          <span className="directory-icon"><FolderIcon /></span>
          <span className={`directory-path ${folder ? '' : 'directory-path-empty'}`}>{folder ?? '尚未選擇目錄'}</span>
          <button className="choose-directory" type="button" onClick={onChooseDirectory} disabled={busy || inspection.kind === 'inspecting'}>選擇目錄</button>
        </div>}
        <p className={`directory-detail ${folderState.tone}`} aria-live="polite">{folderState.detail}</p>
        {inspection.kind === 'none' ? <p className="suggested-path">建議位置：<code>{suggestedPath}</code></p> : null}

        <button className="onboarding-primary" type="button" disabled={!ready} onClick={() => { if (packagePath && folder) onImport(packagePath, folder); }}
          data-testid="onboarding-import-confirm">{busy ? '正在匯入…' : '匯入並建立知識庫'}</button>
        {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
        <button className="onboarding-secondary" type="button" disabled={busy} onClick={onBack}>返回</button>
      </section>
    </main>
  </div>;
}

/** The screen after a Vault was created from an export file: how many documents it holds and where. */
export function ImportDone({ vaultPath, documentCount, onEnter }: { vaultPath: string; documentCount: number; onEnter: () => void }) {
  return <div className="onboarding-screen">
    <header className="onboarding-header">
      <div className="onboarding-brand"><span className="brand-mark" aria-hidden="true">XR</span><span>XR Collector</span></div>
    </header>
    <main className="onboarding-main">
      <section className="onboarding-card" aria-labelledby="onboarding-done-title" data-testid="onboarding-import-done">
        <p className="eyebrow">完成</p>
        <h1 id="onboarding-done-title">已從匯出檔建立知識庫</h1>
        <p className="onboarding-intro">{documentCount} 份文件</p>
        <code className="onboarding-code">{vaultPath}</code>
        <button className="onboarding-primary" type="button" onClick={onEnter} data-testid="onboarding-enter">開始使用</button>
      </section>
    </main>
  </div>;
}
