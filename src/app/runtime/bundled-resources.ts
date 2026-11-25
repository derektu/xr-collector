import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ResourceLayout =
  | { packaged: false; checkout: string }
  // External: Electron's `process.resourcesPath` is the path to the package's resources folder.
  // https://github.com/electron/electron/blob/v44.10.0/docs/api/process.md#processresourcespath-readonly
  | { packaged: true; resourcesPath: string };

export interface BundledResources {
  program(name: string, environmentName: string): string;
  readonly searchBinary: string;
  readonly searchLexicon: string;
  readonly skill: string;
  readonly trayIcons: string;
}

export interface ResourceEnvironment {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
}

export function bundledResources(layout: ResourceLayout, environment: ResourceEnvironment = {}): BundledResources {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = layout.packaged ? layout.resourcesPath : paths.join(layout.checkout, 'resources');
  const runtimeFolder = layout.packaged ? paths.join(root, 'bin') : paths.join(root, 'bin', platform === 'win32' ? 'win' : 'mac');
  const override = (environmentName: string): string | undefined => layout.packaged ? undefined : env[environmentName];
  const program = (name: string, environmentName: string): string =>
    override(environmentName) ?? paths.join(runtimeFolder, platform === 'win32' ? `${name}.exe` : name);
  return {
    program,
    searchBinary: program('meilisearch', 'XR_COLLECTOR_MEILISEARCH'),
    searchLexicon: paths.resolve(override('XR_COLLECTOR_SEARCH_LEXICON') ?? paths.join(root, 'search', 'coct-main.txt')),
    skill: paths.join(layout.packaged ? layout.resourcesPath : layout.checkout, 'skills', 'xr-collector-agent'),
    trayIcons: paths.join(root, 'tray'),
  };
}

/** Only development entry points call it; a package has no checkout. */
export function checkoutRoot(): string {
  const compiled = new URL('../../', import.meta.url).pathname.endsWith('/dist/node/');
  return path.resolve(fileURLToPath(new URL(compiled ? '../../../../' : '../../../', import.meta.url)));
}
