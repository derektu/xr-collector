import type { ElectronThemeBridge } from './app-shell.js';
/** Native desktop capabilities that business screens cannot get over HTTP. */
export interface DesktopBridge { chooseDirectory(defaultPath?: string): Promise<string | null>; }
declare global { interface Window { xrCollectorTheme?: ElectronThemeBridge; xrCollectorDesktop?: DesktopBridge; } }
export {};
