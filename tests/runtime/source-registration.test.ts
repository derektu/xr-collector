import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourcePlugin } from '../../src/core/source-contract.js';
import type { SourceRegistry } from '../../src/core/source-registry.js';
import { sourceRegistry } from '../../src/plugins/index.js';
import { CollectorRuntime, type CollectorRuntimeOptions } from '../../src/runtime/collector-runtime.js';
import { UnavailableTranscriptSearch } from '../../src/search/managed-transcript-search.js';
import { createFakePlugin, FAKE, FakeSource } from '../support/fake-source-plugin.js';
import { PRODUCT_SOURCES } from '../support/product-sources.js';
import { eventually } from '../support/wait.js';
import { productPlugins, youtubePlugins } from '../support/youtube-sources.js';

// A runtime runs with the source types it is given: its plugins must be those types in their order,
// or it would run jobs the Vault and the HTTP API do not know, and two runtimes in one process each
// answer from their own types.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-registration-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Options of a runtime over its own profile and Vault, with no search engine. */
async function options(sources: SourceRegistry, plugins: readonly SourcePlugin[]): Promise<CollectorRuntimeOptions> {
  const root = await temp();
  return {
    profilePath: path.join(root, 'profile'), sources, explicitVaultPath: path.join(root, 'vault'),
    workspace: {
      plugins, searchBinary: 'unused', searchData: path.join(root, 'search'),
      exportFolder: path.join(root, 'exports'), backupFolder: path.join(root, 'backups'),
      createSearch: async () => ({ search: new UnavailableTranscriptSearch('test'), close: async () => undefined }),
    },
    agentSettingsFile: path.join(root, 'agent-settings.json'), skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0,
  };
}

async function start(sources: SourceRegistry, plugins: readonly SourcePlugin[]): Promise<CollectorRuntime> {
  const runtime = await CollectorRuntime.start(await options(sources, plugins));
  cleanups.push(() => runtime.close());
  return runtime;
}

describe('a runtime and its source types', () => {
  it('does not start with plugins other than its types, in their order, and opens nothing', async () => {
    const missing = await options(PRODUCT_SOURCES, youtubePlugins());
    await expect(CollectorRuntime.start(missing)).rejects.toThrow('The plugins (youtube) are not the registered source types (youtube, rss)');
    expect(await readdir(path.dirname(missing.profilePath))).toEqual([]);
    const reordered = await options(PRODUCT_SOURCES, [...productPlugins()].reverse());
    await expect(CollectorRuntime.start(reordered)).rejects.toThrow('The plugins (rss, youtube) are not the registered source types (youtube, rss)');
  });

  it('runs beside a runtime of other types in the same process, each with its own', async () => {
    const product = await start(PRODUCT_SOURCES, productPlugins());
    const fake = await start(sourceRegistry([FAKE]), [createFakePlugin(FAKE, new FakeSource('fake'))]);
    const get = (runtime: CollectorRuntime, route: string) => fetch(`${runtime.server.url}${route}`);
    const post = (runtime: CollectorRuntime, route: string, body: unknown) => fetch(`${runtime.server.url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const types = async (runtime: CollectorRuntime) =>
      ((await (await get(runtime, '/api/source-types')).json()) as { sourceTypes: { id: string }[] }).sourceTypes.map((type) => type.id);

    expect(await types(product)).toEqual(['youtube', 'rss']);
    expect(await types(fake)).toEqual(['fake']);
    expect(product.workspace!.subscriptions.all().map((service) => service.type)).toEqual(['youtube', 'rss']);
    expect(fake.workspace!.subscriptions.all().map((service) => service.type)).toEqual(['fake']);

    // A fake item address is a fake item to one runtime and an RSS address, which names no item, to the other.
    const item = 'https://fake.example/item/one-1';
    expect((await post(fake, '/api/items', { url: item })).status).toBe(202);
    const refused = await post(product, '/api/items', { url: item });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.code).toBe('invalid_url');
    await eventually(async () => {
      const page = await (await get(fake, '/api/documents?sourceType=fake')).json() as { documents: { id: string }[] };
      expect(page.documents.map((document) => document.id)).toEqual(['fake:one-1']);
    });
    expect((await get(product, '/api/documents?sourceType=fake')).status).toBe(400);
    expect((await get(fake, '/api/documents?sourceType=youtube')).status).toBe(400);
    expect((await (await get(product, '/api/documents')).json()).documents).toEqual([]);
  });
});
