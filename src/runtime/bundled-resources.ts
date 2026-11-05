import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the files the App ships beside its code live: the runtime programs (Meilisearch and the
 * programs the source plugins run), the search lexicon, the Agent Skill and the tray icons. This module is the only place
 * that knows their layout; every entry point asks it for the paths.
 *
 * Development runs read them from the checkout: `resources/bin/<mac|win>`, `resources/search`,
 * `resources/tray` and `skills`. A package reads them from its resources folder, where
 * `electron-builder.yml` puts them: `bin`, `search`, `tray` and `skills`
 * (`tests/runtime/bundled-resources.test.ts` checks the two agree).
 */
export type ResourceLayout =
  | { packaged: false; /** The checkout's root folder. */ checkout: string }
  | { packaged: true; /** The package's resources folder (Electron's `process.resourcesPath`). */ resourcesPath: string };

export interface BundledResources {
  /**
   * An external program, by its path under the runtime folder without extension, such as
   * `meilisearch`. Outside a package the environment variable `environmentName` may name it instead.
   */
  program(name: string, environmentName: string): string;
  /** The Meilisearch program. */
  readonly searchBinary: string;
  /** The search lexicon. `XR_COLLECTOR_SEARCH_LEXICON` may name it instead, in a package too. */
  readonly searchLexicon: string;
  /** The folder of the Agent Skill the App hands to Agents. */
  readonly skill: string;
  /** The folder of the tray icons. */
  readonly trayIcons: string;
}

export interface ResourceEnvironment {
  /** Defaults to `process.platform`; Windows paths use Windows separators. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The paths of the bundled resources for `layout` on `platform`. */
export function bundledResources(layout: ResourceLayout, environment: ResourceEnvironment = {}): BundledResources {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = layout.packaged ? layout.resourcesPath : paths.join(layout.checkout, 'resources');
  const runtimeFolder = layout.packaged ? paths.join(root, 'bin') : paths.join(root, 'bin', platform === 'win32' ? 'win' : 'mac');
  const program = (name: string, environmentName: string): string => {
    const override = layout.packaged ? undefined : env[environmentName];
    return override ?? paths.join(runtimeFolder, platform === 'win32' ? `${name}.exe` : name);
  };
  return {
    program,
    searchBinary: program('meilisearch', 'XR_COLLECTOR_MEILISEARCH'),
    searchLexicon: paths.resolve(env.XR_COLLECTOR_SEARCH_LEXICON ?? paths.join(root, 'search', 'coct-main.txt')),
    skill: paths.join(layout.packaged ? layout.resourcesPath : layout.checkout, 'skills', 'xr-collector-agent'),
    trayIcons: paths.join(root, 'tray'),
  };
}

/**
 * The checkout this module runs from, whether from source (`src/runtime`) or from the build
 * (`dist/node/runtime`). Only development entry points use it; a package has no checkout.
 */
export function checkoutRoot(): string {
  const compiled = new URL('../', import.meta.url).pathname.endsWith('/dist/node/');
  return path.resolve(fileURLToPath(new URL(compiled ? '../../../' : '../../', import.meta.url)));
}
