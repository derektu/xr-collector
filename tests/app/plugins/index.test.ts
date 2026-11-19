import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SourceEntry } from '../../../src/shared/sources/source-contract.js';
import { SOURCE_DECLARATIONS } from '../../../src/app/plugins/declarations.js';
import { serverSources, SOURCES } from '../../../src/app/plugins/index.js';
import { SOURCE_ICONS } from '../../../src/transport/web/plugins.js';
import { fakeDefinition } from '../../support/fake-source-plugin.js';

// Guards a new source type added on one side only. The server and the UI take their types from one
// declaration list; a type the server collects but the UI does not know shows every one of its jobs
// as a subscription job, with an empty noun and no icon, while everything still compiles.

const ids = SOURCE_DECLARATIONS.map((declaration) => declaration.id);
const entry = (id: string): SourceEntry => ({ definition: fakeDefinition(id, `${id}-net`), create: () => { throw new Error('not built'); } });

describe('the product\'s source list', () => {
  it('gives the server the declared types, in the declared order, each defined from its declaration', () => {
    expect(ids.length).toBeGreaterThan(1);
    expect(SOURCES.map((source) => source.definition.id)).toEqual(ids);
    SOURCES.forEach((source, index) => expect(source.definition).toMatchObject(SOURCE_DECLARATIONS[index]!));
  });

  it('lists the type that owns every web address last, so the first owner of an address is never the catch-all by mistake', () => {
    const address = 'https://example.test/any/page';
    const catchAll = SOURCE_DECLARATIONS.filter((declaration) => declaration.owns(address, new URL(address))).map((declaration) => declaration.id);
    expect(catchAll).toEqual([ids.at(-1)]);
  });

  it('refuses a declared type without a server entry, and a server entry without a declaration', () => {
    const declarations = [fakeDefinition('fake', 'fake-net'), fakeDefinition('fake2', 'fake2-net')];
    expect(serverSources(declarations, { fake: entry('fake'), fake2: entry('fake2') }).map((source) => source.definition.id)).toEqual(['fake', 'fake2']);
    expect(() => serverSources(declarations, { fake: entry('fake') })).toThrow('Source type fake2 is declared but has no server entry');
    expect(() => serverSources(declarations.slice(0, 1), { fake: entry('fake'), fake2: entry('fake2') }))
      .toThrow('Source types fake2 have server entries but no declaration');
    expect(() => serverSources(declarations.slice(0, 1), { fake: entry('fake2') })).toThrow('The server entry of source type fake defines fake2');
  });

  it('gives every declared type an icon and badge colors in both themes, and no other type', () => {
    const icons = SOURCE_DECLARATIONS.map((declaration) => declaration.icon);
    expect(Object.keys(SOURCE_ICONS).sort()).toEqual([...icons].sort());
    const css = readFileSync('src/transport/web/plugins.css', 'utf8');
    const themes = [...css.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/gu)];
    expect(themes.length).toBeGreaterThan(1);
    for (const icon of icons) {
      for (const [, theme, rules] of themes) {
        expect(rules, `${theme} badge colors of ${icon}`).toMatch(new RegExp(`--badge-${icon}-bg:[^;]+;`, 'u'));
        expect(rules, `${theme} badge colors of ${icon}`).toMatch(new RegExp(`--badge-${icon}-fg:[^;]+;`, 'u'));
      }
      expect(css).toContain(`.type-badge.type-${icon} {`);
      expect(css).toContain(`.log-type.type-${icon} {`);
    }
  });
});
