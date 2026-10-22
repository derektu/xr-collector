import path from 'node:path';
import { registerScheduleFile, registerSourceDefinitions } from '../core/source-registry.js';
import { PacingGate, pacingOptionsFromEnv, pacingStateFile } from '../pacing/pacing-gate.js';
import type { SourceDefinition, SourceEntry, SourcePlugin } from './types.js';
import { createRssPlugin, rssDefinition } from './rss/server.js';
import { createYouTubePlugin, youtubeDefinition } from './youtube/server.js';

/**
 * The source types this product offers, in display order. Adding a type means adding its entry
 * here. An address belongs to the first type that owns it, so RSS, which owns every web address,
 * comes last.
 */
export const SOURCES: readonly SourceEntry[] = [
  { definition: youtubeDefinition, create: createYouTubePlugin },
  { definition: rssDefinition as SourceDefinition, create: createRssPlugin },
];

export const SOURCE_DEFINITIONS: readonly SourceDefinition[] = SOURCES.map((entry) => entry.definition);

/** The Vault file of the automatic collection switch that covers every type's subscriptions. */
export const SCHEDULE_FILE = 'settings/youtube-schedule.json';
const SCHEDULE_DESCRIPTION = 'YouTube channel schedule';

/** Registers the product's source types; the composition roots call it before opening a Vault. */
export function registerSources(): void {
  registerSourceDefinitions(SOURCE_DEFINITIONS);
  registerScheduleFile(SCHEDULE_FILE, SCHEDULE_DESCRIPTION);
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
