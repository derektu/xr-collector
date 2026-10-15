import { useState, type FormEvent } from 'react';
import './onboarding.css';

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

export function Onboarding({ inspection, suggestedPath, originalFailure, busy = false, error, pathEntry = 'dialog', onChooseDirectory, onSubmitPath, onContinue }: OnboardingProps) {
  const [typedPath, setTypedPath] = useState('');
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
        <h1 id="onboarding-title">選擇知識庫位置</h1>
        <p className="onboarding-intro">收集的文件會保存在所選的目錄中，方便你自行備份與管理。</p>

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
        <p className="onboarding-footnote">XR Collector 只會在你確認後建立或開啟知識庫。</p>
      </section>
    </main>
  </div>;
}
