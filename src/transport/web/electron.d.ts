import type { ElectronThemeBridge } from './app-shell.js';
import type { DesktopNavigationTarget } from './desktop-navigation.js';
import type { DesktopPlatform } from '../../shared/api/device-types.js';
export interface DesktopBridge {
  chooseVaultLocation(start?: string): Promise<string | null>;
  chooseVault(start?: string): Promise<string | null>;
  chooseExportFile(): Promise<{ path: string; overwriteConfirmed: boolean } | null>;
  chooseImportFile(): Promise<string | null>;
  revealVault(): Promise<void>;
  revealTransferFile(): Promise<void>;
  platform: DesktopPlatform;
  navigationReady(): void;
  onNavigate(listener: (target: DesktopNavigationTarget | 'settings' | 'update') => void): void;
}
declare global { interface Window { xrCollectorTheme?: ElectronThemeBridge; xrCollectorDesktop?: DesktopBridge; } }
export {};
