import type { ElectronThemeBridge } from './app-shell.js';
import type { DesktopNavigationTarget } from './desktop-navigation.js';
export interface DesktopBridge {
  chooseVaultLocation(start?: string): Promise<string | null>;
  chooseVault(start?: string): Promise<string | null>;
  chooseExportFile(): Promise<{ path: string; overwrite: boolean } | null>;
  chooseImportFile(): Promise<string | null>;
  revealVault(): Promise<void>;
  revealExport(): Promise<void>;
  platform: string;
  ready(): void;
  onNavigate(listener: (target: DesktopNavigationTarget | 'settings' | 'update') => void): void;
}
declare global { interface Window { xrCollectorTheme?: ElectronThemeBridge; xrCollectorDesktop?: DesktopBridge; } }
export {};
