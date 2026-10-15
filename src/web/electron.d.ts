import type { ElectronThemeBridge } from './app-shell.js';
/** Native desktop capabilities that business screens cannot get over HTTP. */
export interface DesktopBridge {
  chooseDirectory(defaultPath?: string): Promise<string | null>;
  /**
   * Native save dialog for a backup file, starting at `defaultPath`; null when cancelled.
   * `overwrite` is true when the dialog itself confirmed replacing an existing file.
   */
  chooseBackupToSave(defaultPath: string): Promise<{ path: string; overwrite: boolean } | null>;
  /** Native open dialog for a backup file; null when cancelled. */
  chooseBackupToOpen(): Promise<string | null>;
}
declare global { interface Window { xrCollectorTheme?: ElectronThemeBridge; xrCollectorDesktop?: DesktopBridge; } }
export {};
