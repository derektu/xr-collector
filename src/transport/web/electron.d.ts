import type { ElectronThemeBridge } from './app-shell.js';
import type { DesktopNavigationTarget } from './desktop-navigation.js';
/** Native desktop capabilities that business screens cannot get over HTTP. */
export interface DesktopBridge {
  /** Native folder picker for where a new Vault goes, starting at `start`; null when cancelled. */
  chooseVaultLocation(start?: string): Promise<string | null>;
  /** Native folder picker for an existing Vault, starting at `start`; null when cancelled. */
  chooseVault(start?: string): Promise<string | null>;
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
  /** Announces that navigation listeners are attached, so startup targets can drain exactly once. */
  ready(): void;
  /** Calls `listener` when the tray menu opens the window on a page. */
  onNavigate(listener: (target: DesktopNavigationTarget | 'settings' | 'update') => void): void;
}
declare global { interface Window { xrCollectorTheme?: ElectronThemeBridge; xrCollectorDesktop?: DesktopBridge; } }
export {};
