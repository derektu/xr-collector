import { useState, type FormEvent, type ReactNode } from 'react';
import './onboarding.css';
import type { PackageDescription } from '../core/types.js';
import { AgentConnectionHelp } from './AgentConnectionHelp.js';
import { AgentConnection } from './AgentConnection.js';
import { ListRow } from './NewVaultFields.js';

/** The Onboarding page frame: the brand header and one card. */
export function OnboardingFrame({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="onboarding-screen">
    <header className="onboarding-header">
      <div className="onboarding-brand"><span className="brand-mark" aria-hidden="true">XR</span><span>XR Collector</span></div>
    </header>
    <main className="onboarding-main">
      <section className="onboarding-card" data-testid={testId}>{children}</section>
    </main>
  </div>;
}

export interface OnboardingHomeProps {
  /** The previously used Vault that could not be opened at startup. */
  originalFailure?: { path: string; reason: string };
  busy: boolean;
  /** Why the last open or export-file choice failed. */
  error?: string;
  /** `dialog` uses the desktop pickers; `manual` lets a browser session type a host path to open. */
  pathEntry: 'dialog' | 'manual';
  onCreate: () => void;
  /** Opens the Vault at `path`, or asks the desktop picker for one when `path` is left out. */
  onOpen: (path?: string) => void;
  onFromExport: () => void;
}

/** The first Onboarding screen: create a new Vault, open an existing one, or create one from an export file. */
export function OnboardingHome({ originalFailure, busy, error, pathEntry, onCreate, onOpen, onFromExport }: OnboardingHomeProps) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typedPath, setTypedPath] = useState('');

  return <OnboardingFrame testId="onboarding-home">
    <p className="eyebrow">開始使用</p>
    <div className="onboarding-title-line"><h1 id="onboarding-title">XR Collector</h1><span className="onboarding-agent-label">
      <button type="button" aria-expanded={agentOpen} aria-controls="onboarding-agent-panel" onClick={() => setAgentOpen((value) => !value)}>AI 助理連線</button>
      <AgentConnectionHelp onboarding /></span></div>
    <p className="onboarding-intro">收集的文件存在知識庫資料夾中，方便你自行備份與管理。</p>
    {agentOpen ? <div id="onboarding-agent-panel" data-testid="onboarding-agent-panel"><AgentConnection /></div> : null}

    {originalFailure ? <div className="vault-warning" role="alert" data-testid="onboarding-original-failure">
      <span className="vault-warning-icon" aria-hidden="true">!</span>
      <div><strong>原知識庫無法開啟</strong><p>{originalFailure.reason}</p><code>{originalFailure.path}</code></div>
    </div> : null}

    <div className="ob-list" data-testid="onboarding-entries">
      <ListRow title="建立新的知識庫" detail="在指定的資料夾下建立新的知識庫。">
        <button type="button" className="button primary" disabled={busy} onClick={onCreate} data-testid="onboarding-create">建立</button>
      </ListRow>
      <ListRow title="開啟既有知識庫" detail="選擇電腦上已有的知識庫資料夾。">
        <button type="button" className="button" disabled={busy} onClick={() => (pathEntry === 'manual' ? setTyping(true) : onOpen())}
          data-testid="onboarding-open">開啟</button>
      </ListRow>
      {typing ? <form className="ob-row ob-manual" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (typedPath.trim()) onOpen(typedPath.trim());
      }}>
        <input className="url-input" value={typedPath} placeholder="知識庫資料夾的完整路徑" spellCheck={false} aria-label="知識庫資料夾"
          onChange={(event) => setTypedPath(event.target.value)} data-testid="onboarding-open-path" />
        <button type="submit" className="button" disabled={busy || !typedPath.trim()} data-testid="onboarding-open-confirm">開啟</button>
      </form> : null}
      <ListRow title="從匯出檔建立" detail="用匯出的 .zip 建立新的知識庫。">
        <button type="button" className="button" disabled={busy} onClick={onFromExport} data-testid="onboarding-from-export">選擇檔案</button>
      </ListRow>
    </div>
    {error ? <p className="ob-error" role="alert" data-testid="onboarding-error">{error}</p> : null}
  </OnboardingFrame>;
}

/** A sub-screen of Onboarding: a way back to the first screen, its title and its content. */
export function OnboardingStep({ title, busy, onBack, children, testId }: {
  title: string; busy: boolean; onBack: () => void; children: ReactNode; testId: string;
}) {
  return <OnboardingFrame testId={testId}>
    <button type="button" className="ob-back" disabled={busy} onClick={onBack} data-testid="onboarding-back">← 返回</button>
    <div className="onboarding-title-line"><h1>{title}</h1></div>
    <div className="ob-form">{children}</div>
  </OnboardingFrame>;
}

function localDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** What an export file holds, as the row that shows it says it: its date, documents and subscriptions. */
export function packageSummary(described: PackageDescription): string {
  const date = described.exportedAt ? localDate(described.exportedAt) : '';
  return `${date ? `${date} 匯出，` : ''}${described.documents} 份文件、${described.subscriptions} 個訂閱`;
}

/**
 * The export-file row of creating a Vault from an export: the chosen file with what it holds on the
 * line under it, and a desktop picker, or a typed path in a browser session.
 */
export function PackageRow({ described, busy, pathEntry, onChoose, onSubmitPath }: {
  described: PackageDescription | null;
  busy: boolean;
  pathEntry: 'dialog' | 'manual';
  onChoose: () => void;
  onSubmitPath: (path: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const summary = described ? <span className="ob-file-summary" data-testid="onboarding-package-summary">{packageSummary(described)}</span> : null;
  return <ListRow title="匯出檔" field testId="onboarding-package">
    {pathEntry === 'manual' ? <form className="ob-control" onSubmit={(event: FormEvent) => {
      event.preventDefault();
      if (typed.trim()) onSubmitPath(typed.trim());
    }}>
      <div className="ob-file">
        <input className="url-input ob-path-input" value={typed} placeholder={described?.path ?? '匯出檔的完整路徑'} spellCheck={false} aria-label="匯出檔"
          onChange={(event) => setTyped(event.target.value)} data-testid="onboarding-package-input" />
        {summary}
      </div>
      <button type="submit" className="button" disabled={busy || !typed.trim()} data-testid="onboarding-package-read">讀取</button>
    </form> : <div className="ob-control">
      <div className="ob-file">
        <span className={`ob-path ${described ? '' : 'empty'}`} title={described?.path} data-testid="onboarding-package-name">{described?.fileName ?? '尚未選擇'}</span>
        {summary}
      </div>
      <button type="button" className="button" disabled={busy} onClick={onChoose} data-testid="onboarding-package-choose">選擇檔案</button>
    </div>}
  </ListRow>;
}
