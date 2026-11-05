import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectorRuntimeOptions } from '../../src/runtime/collector-runtime.js';
import { productPlugins, youtubePlugins } from '../support/youtube-sources.js';

// Guards an entry point that starts the runtime without registering the source types, or with
// plugins other than the registered ones: it would run with no subscription collections, or with
// jobs the Vault and the HTTP API do not know, and nothing would say so. Each case loads its own copy
// of the modules, so the registry starts empty as it does in a new process.

const roots: string[] = [];
afterEach(async () => {
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fresh() {
  vi.resetModules();
  const runtime = await import('../../src/runtime/collector-runtime.js');
  const registry = await import('../../src/core/source-registry.js');
  const plugins = await import('../../src/plugins/index.js');
  return { CollectorRuntime: runtime.CollectorRuntime, registry, registerSources: plugins.registerSources };
}

async function options(plugins: CollectorRuntimeOptions['workspace']): Promise<CollectorRuntimeOptions> {
  const root = await mkdtemp(path.join(tmpdir(), 'xr-registration-'));
  roots.push(root);
  return {
    profilePath: root, workspace: plugins, agentSettingsFile: path.join(root, 'agent-settings.json'),
    skillPath: path.resolve('skills/xr-collector-agent'), uiPort: 0,
  };
}

const workspaceWith = (plugins: ReturnType<typeof productPlugins>) => ({ plugins }) as unknown as CollectorRuntimeOptions['workspace'];

describe('a runtime and the registered source types', () => {
  it('reads no source type before any is registered', async () => {
    const { registry } = await fresh();
    expect(() => registry.subscriptionDefinitions()).toThrow('No source definitions are registered');
    expect(() => registry.sourceDeclarations()).toThrow('No source types are registered');
    expect(() => registry.sourceDeclaration('youtube')).toThrow('No source types are registered');
  });

  it('does not start before the source types are registered, and opens nothing', async () => {
    const { CollectorRuntime } = await fresh();
    const withoutVault = await options(null);
    await expect(CollectorRuntime.start(withoutVault)).rejects.toThrow('No source definitions are registered');
    const withVault = await options(workspaceWith(productPlugins()));
    await expect(CollectorRuntime.start(withVault)).rejects.toThrow('No source definitions are registered');
    expect(await readdir(withVault.profilePath)).toEqual([]);
  });

  it('does not start with plugins other than the registered types, in their order', async () => {
    const { CollectorRuntime, registerSources } = await fresh();
    registerSources();
    const missing = await options(workspaceWith(youtubePlugins()));
    await expect(CollectorRuntime.start(missing)).rejects.toThrow('The plugins (youtube) are not the registered source types (youtube, rss)');
    expect(await readdir(missing.profilePath)).toEqual([]);
    const reordered = await options(workspaceWith([...productPlugins()].reverse()));
    await expect(CollectorRuntime.start(reordered)).rejects.toThrow('The plugins (rss, youtube) are not the registered source types (youtube, rss)');
  });
});
