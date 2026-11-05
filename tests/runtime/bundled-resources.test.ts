// Where the App looks for the files it ships beside its code: the runtime programs, the macOS update
// helper, the search lexicon, the Agent Skill and the tray icons. A wrong path, or a package whose
// electron-builder.yml puts a file somewhere the App does not look, leaves the App without search,
// collection, tray icons or updates on that platform while every other test passes. A Mac package
// that cannot update never receives the release that fixes it.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from 'app-builder-lib/out/util/config/config.js';
import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';
import { bundledResources, checkoutRoot, type ResourceLayout } from '../../src/runtime/bundled-resources.js';

const OVERRIDES = {
  XR_COLLECTOR_MEILISEARCH: '/custom/meilisearch',
  XR_COLLECTOR_YTDLP: '/custom/yt-dlp',
  XR_COLLECTOR_DENO: '/custom/deno',
  XR_COLLECTOR_SEARCH_LEXICON: '/custom/lexicon.txt',
};

/** Every path the App asks for on `platform`, by name. Only the Mac App asks for the update helper. */
function answers(layout: ResourceLayout, platform: NodeJS.Platform, env: Record<string, string> = {}): Record<string, string> {
  const resources = bundledResources(layout, { platform, env });
  return {
    meilisearch: resources.searchBinary,
    ytDlp: resources.program('yt-dlp/yt-dlp', 'XR_COLLECTOR_YTDLP'),
    deno: resources.program('deno', 'XR_COLLECTOR_DENO'),
    lexicon: resources.searchLexicon,
    skill: resources.skill,
    trayIcons: resources.trayIcons,
    ...(platform === 'darwin' ? { macUpdateHelper: resources.macUpdateHelper } : {}),
  };
}

describe('the paths of the bundled resources', () => {
  it('reads a Mac development run from the checkout, mac runtime folder', () => {
    expect(answers({ packaged: false, checkout: '/work/xr-collector' }, 'darwin')).toEqual({
      meilisearch: '/work/xr-collector/resources/bin/mac/meilisearch',
      ytDlp: '/work/xr-collector/resources/bin/mac/yt-dlp/yt-dlp',
      deno: '/work/xr-collector/resources/bin/mac/deno',
      lexicon: '/work/xr-collector/resources/search/coct-main.txt',
      skill: '/work/xr-collector/skills/xr-collector-agent',
      trayIcons: '/work/xr-collector/resources/tray',
      macUpdateHelper: '/work/xr-collector/resources/bin/mac/xr-mac-update-helper',
    });
  });

  it('reads a Windows development run from the checkout, win runtime folder, with .exe programs', () => {
    expect(answers({ packaged: false, checkout: 'C:\\projects\\xr-collector' }, 'win32')).toEqual({
      meilisearch: 'C:\\projects\\xr-collector\\resources\\bin\\win\\meilisearch.exe',
      ytDlp: 'C:\\projects\\xr-collector\\resources\\bin\\win\\yt-dlp\\yt-dlp.exe',
      deno: 'C:\\projects\\xr-collector\\resources\\bin\\win\\deno.exe',
      lexicon: 'C:\\projects\\xr-collector\\resources\\search\\coct-main.txt',
      skill: 'C:\\projects\\xr-collector\\skills\\xr-collector-agent',
      trayIcons: 'C:\\projects\\xr-collector\\resources\\tray',
    });
  });

  it('reads a Mac package from its Contents/Resources', () => {
    const resources = '/Applications/XR Collector.app/Contents/Resources';
    expect(answers({ packaged: true, resourcesPath: resources }, 'darwin')).toEqual({
      meilisearch: `${resources}/bin/meilisearch`,
      ytDlp: `${resources}/bin/yt-dlp/yt-dlp`,
      deno: `${resources}/bin/deno`,
      lexicon: `${resources}/search/coct-main.txt`,
      skill: `${resources}/skills/xr-collector-agent`,
      trayIcons: `${resources}/tray`,
      macUpdateHelper: `${resources}/bin/xr-mac-update-helper`,
    });
  });

  it('reads a Windows package from the resources folder beside its .exe', () => {
    const resources = 'C:\\Users\\me\\AppData\\Local\\Programs\\XR Collector\\resources';
    expect(answers({ packaged: true, resourcesPath: resources }, 'win32')).toEqual({
      meilisearch: `${resources}\\bin\\meilisearch.exe`,
      ytDlp: `${resources}\\bin\\yt-dlp\\yt-dlp.exe`,
      deno: `${resources}\\bin\\deno.exe`,
      lexicon: `${resources}\\search\\coct-main.txt`,
      skill: `${resources}\\skills\\xr-collector-agent`,
      trayIcons: `${resources}\\tray`,
    });
  });

  it('lets the environment name every program and the lexicon in a development run', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(answers({ packaged: false, checkout: '/work/xr-collector' }, platform, OVERRIDES)).toMatchObject({
        meilisearch: OVERRIDES.XR_COLLECTOR_MEILISEARCH,
        ytDlp: OVERRIDES.XR_COLLECTOR_YTDLP,
        deno: OVERRIDES.XR_COLLECTOR_DENO,
        lexicon: path[platform === 'win32' ? 'win32' : 'posix'].resolve(OVERRIDES.XR_COLLECTOR_SEARCH_LEXICON),
      });
    }
  });

  it('uses a Mac package\'s own programs and lexicon whatever the environment names', () => {
    expect(answers({ packaged: true, resourcesPath: '/R' }, 'darwin', OVERRIDES)).toMatchObject({
      meilisearch: '/R/bin/meilisearch', ytDlp: '/R/bin/yt-dlp/yt-dlp', deno: '/R/bin/deno',
      lexicon: '/R/search/coct-main.txt', macUpdateHelper: '/R/bin/xr-mac-update-helper',
    });
  });

  it('uses a Windows package\'s own programs and lexicon whatever the environment names', () => {
    expect(answers({ packaged: true, resourcesPath: 'C:\\R' }, 'win32', OVERRIDES)).toMatchObject({
      meilisearch: 'C:\\R\\bin\\meilisearch.exe', ytDlp: 'C:\\R\\bin\\yt-dlp\\yt-dlp.exe', deno: 'C:\\R\\bin\\deno.exe',
      lexicon: 'C:\\R\\search\\coct-main.txt',
    });
  });

  it('finds the checkout this module runs from', () => {
    expect(existsSync(path.join(checkoutRoot(), 'package.json'))).toBe(true);
    const own = bundledResources({ packaged: false, checkout: checkoutRoot() }, { env: {} });
    for (const file of [own.searchLexicon, own.skill, own.trayIcons]) expect(existsSync(file), file).toBe(true);
  });
});

type ExtraResource = string | { from?: string; to?: string; filter?: string | string[] };

/**
 * The checkout file electron-builder copies to `packaged` (a path under the package's resources
 * folder, with `/` separators), or null when no entry of `entries` puts a file there.
 */
function packagedFrom(entries: readonly ExtraResource[], packaged: string): string | null {
  for (const entry of entries) {
    if (typeof entry === 'string' || !entry.from || !entry.to) continue;
    if (packaged !== entry.to && !packaged.startsWith(`${entry.to}/`)) continue;
    const inside = packaged.slice(entry.to.length + 1);
    const filters = entry.filter === undefined ? [] : [entry.filter].flat();
    if (inside && filters.length > 0 && !filters.some((filter) => minimatch(inside, filter))) continue;
    return inside ? `${entry.from}/${inside}` : entry.from;
  }
  return null;
}

describe('the package puts each resource where the App looks', async () => {
  const config = await getConfig(process.cwd(), path.resolve('electron-builder.yml'), null);
  const targets = [
    { name: 'mac', platform: 'darwin', entries: config.mac?.extraResources, flavor: path.posix, packagedRoot: '/R', checkout: '/C' },
    { name: 'win', platform: 'win32', entries: config.win?.extraResources, flavor: path.win32, packagedRoot: 'C:\\R', checkout: 'C:\\C' },
  ] as const;

  for (const target of targets) {
    it(`copies every ${target.name} resource from the file a development run reads`, () => {
      const entries = (target.entries ?? []) as ExtraResource[];
      const packaged = answers({ packaged: true, resourcesPath: target.packagedRoot }, target.platform);
      const development = answers({ packaged: false, checkout: target.checkout }, target.platform);
      const relative = (root: string, file: string) => target.flavor.relative(root, file).split(target.flavor.sep).join('/');
      const copies = Object.fromEntries(Object.entries(packaged)
        .map(([name, file]) => [name, packagedFrom(entries, relative(target.packagedRoot, file))]));
      const sources = Object.fromEntries(Object.entries(development)
        .map(([name, file]) => [name, relative(target.checkout, file)]));
      expect(copies).toEqual(sources);
    });
  }
});
