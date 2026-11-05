import path from 'node:path';
import { registerScheduleFile, registerSourceDefinitions } from '../core/source-registry.js';
import { registerSubscriptionExchange } from '../core/subscription-exchange.js';
import { PacingGate, pacingOptionsFromEnv, pacingStateFile } from '../pacing/pacing-gate.js';
import type { SourceDefinition, SourceEntry, SourcePlugin, SourcePluginDeclaration } from '../core/source-contract.js';
import { SOURCE_DECLARATIONS } from './declarations.js';
import { subscriptionFileExchange } from '../subscriptions/subscription-file-exchange.js';
import { createRssPlugin, rssDefinition } from './rss/server.js';
import { createYouTubePlugin, youtubeDefinition } from './youtube/server.js';

/** The server entry of each source type, by type ID. */
const SERVER_ENTRIES: Readonly<Record<string, SourceEntry>> = {
  youtube: { definition: youtubeDefinition, create: createYouTubePlugin },
  rss: { definition: rssDefinition as SourceDefinition, create: createRssPlugin },
};

/**
 * The server entries of `declarations`, in their order. Throws when a declared type has no entry, an
 * entry's definition names another type, or an entry has no declared type.
 */
export function serverSources(
  declarations: readonly SourcePluginDeclaration[],
  entries: Readonly<Record<string, SourceEntry>>,
): SourceEntry[] {
  const sources = declarations.map(({ id }) => {
    const entry = entries[id];
    if (!entry) throw new Error(`Source type ${id} is declared but has no server entry`);
    if (entry.definition.id !== id) throw new Error(`The server entry of source type ${id} defines ${entry.definition.id}`);
    return entry;
  });
  const undeclared = Object.keys(entries).filter((id) => !declarations.some((declaration) => declaration.id === id));
  if (undeclared.length > 0) throw new Error(`Source types ${undeclared.join(', ')} have server entries but no declaration`);
  return sources;
}

/** The source types this product offers, in the order of `SOURCE_DECLARATIONS`. */
export const SOURCES: readonly SourceEntry[] = serverSources(SOURCE_DECLARATIONS, SERVER_ENTRIES);

export const SOURCE_DEFINITIONS: readonly SourceDefinition[] = SOURCES.map((entry) => entry.definition);

/** The Vault file of the automatic collection switch that covers every type's subscriptions. */
export const SCHEDULE_FILE = 'settings/youtube-schedule.json';
const SCHEDULE_DESCRIPTION = 'YouTube channel schedule';

/**
 * Registers the product's source types, and the subscription files through which the Vault reads
 * their subscriptions; the composition roots call it before opening a Vault.
 */
export function registerSources(): void {
  registerSourceDefinitions(SOURCE_DEFINITIONS);
  registerScheduleFile(SCHEDULE_FILE, SCHEDULE_DESCRIPTION);
  registerSubscriptionExchange(subscriptionFileExchange);
}

/**
 * Locates an external program a plugin runs, by its file name without extension and the
 * environment variable that may name its path instead.
 */
export type ProgramLocator = (name: string, environmentName: string) => string;

export interface SourcePluginsOptions {
  /** Device profile folder; each pacing group keeps its cooldown state here. */
  profilePath: string;
  env: NodeJS.ProcessEnv;
  program: ProgramLocator;
}

/** The assembled plugins and one request channel per pacing group they declare. */
export interface AssembledSources {
  plugins: SourcePlugin[];
  pacing: PacingGate[];
}

/** Registers the source types and builds their plugins with the request channels they share. */
export async function createSourcePlugins(options: SourcePluginsOptions): Promise<AssembledSources> {
  registerSources();
  const gates = new Map<string, PacingGate>();
  for (const definition of SOURCE_DEFINITIONS) {
    const pacing = definition.pacing;
    if (!pacing || gates.has(pacing.group)) continue;
    gates.set(pacing.group, await PacingGate.open(pacing, {
      statePath: path.join(options.profilePath, pacingStateFile(pacing.group)),
      ...pacingOptionsFromEnv(pacing, options.env),
    }));
  }
  const runtime = {
    profilePath: options.profilePath,
    env: options.env,
    program: options.program,
    gate(group: string): PacingGate {
      const gate = gates.get(group);
      if (!gate) throw new Error(`No source declares the pacing group ${group}`);
      return gate;
    },
  };
  return { plugins: SOURCES.map((entry) => entry.create(runtime)), pacing: [...gates.values()] };
}
