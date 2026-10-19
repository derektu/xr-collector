import type { ElectronThemeBridge } from './app-shell.js';
/** Native desktop capabilities that business screens cannot get over HTTP. */
export interface DesktopBridge {
  chooseDirectory(defaultPath?: string): Promise<string | null>;
  /**
   * Native save dialog for an export file, starting at today's file in the export folder (created
   * when missing); null when cancelled. `overwrite` is true when the dialog itself confirmed
   * replacing an existing file.
   */
  chooseExportFile(): Promise<{ path: string; overwrite: boolean } | null>;
  /** Native open dialog for an export file, starting in the export folder; null when cancelled. */
  chooseImportFile(): Promise<string | null>;
  /** Shows the active Vault folder in Finder or File Explorer. */
  revealVault(): Promise<void>;
  /** Shows the file the last finished export wrote in Finder or File Explorer. */
  revealExport(): Promise<void>;
  /** Operating system of the desktop app, for labels such as Finder or File Explorer. */
  platform: string;
}
declare global { interface Window { xrCollectorTheme?: ElectronThemeBridge; xrCollectorDesktop?: DesktopBridge; } }
export {};
