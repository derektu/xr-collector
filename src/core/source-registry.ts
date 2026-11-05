import type { SourceDefinition, SourcePluginDeclaration } from './source-contract.js';
import type { JobRole } from './types.js';

/**
 * The source types this process knows, in registration order. The composition roots register the
 * product's definitions before anything reads a Vault (`src/plugins/index.ts`); the web UI registers
 * the product's declarations (`src/web/plugins.tsx`). Core modules look types up here instead of
 * naming them, so a document, job or subscription of an unregistered type is data the core keeps but
 * does not act on. Reading the registry before any type is registered throws: a process that skipped
 * the registration would otherwise run without any source type.
 *
 * The module holds no Node-only code, so the web build shares it (tests/tooling/web-bundle-node.test.ts).
 */

const declarations = new Map<string, SourcePluginDeclaration>();
const definitions = new Map<string, SourceDefinition>();
let schedule: { file: string; description: string } | null = null;

/** Registers the declarations of source types; a type registered again keeps its place in the order. */
export function registerSourceDeclarations(list: readonly SourcePluginDeclaration[]): void {
  for (const declaration of list) declarations.set(declaration.id, declaration);
}

/** Registers the server definitions of source types, and their declarations with them. */
export function registerSourceDefinitions(list: readonly SourceDefinition[]): void {
  for (const definition of list) definitions.set(definition.id, definition);
  registerSourceDeclarations(list);
}

/**
 * Names the Vault file of the automatic collection switch, relative to the Vault root, and how
 * diagnostics name its content. One switch covers the subscriptions of every type; the assembly
 * names its file.
 */
export function registerScheduleFile(file: string, description: string): void {
  schedule = { file, description };
}

export function scheduleFile(): string {
  if (!schedule) throw new Error('No schedule file is registered');
  return schedule.file;
}

export function scheduleFileDescription(): string {
  if (!schedule) throw new Error('No schedule file is registered');
  return schedule.description;
}

function registeredDeclarations(): Map<string, SourcePluginDeclaration> {
  if (declarations.size === 0) throw new Error('No source types are registered');
  return declarations;
}

function registeredDefinitions(): Map<string, SourceDefinition> {
  if (definitions.size === 0) throw new Error('No source definitions are registered');
  return definitions;
}

/** Every registered declaration, in registration order. */
export function sourceDeclarations(): SourcePluginDeclaration[] {
  return [...registeredDeclarations().values()];
}

export function sourceDeclaration(type: string): SourcePluginDeclaration | undefined {
  return registeredDeclarations().get(type);
}

/** Every registered server definition, in registration order. */
export function sourceDefinitions(): SourceDefinition[] {
  return [...registeredDefinitions().values()];
}

export function sourceDefinition(type: string): SourceDefinition | undefined {
  return registeredDefinitions().get(type);
}

/** The server definition of a type the caller knows is registered. */
export function requireDefinition(type: string): SourceDefinition {
  const definition = registeredDefinitions().get(type);
  if (!definition) throw new Error(`Source type ${type} is not registered`);
  return definition;
}

/** Registered definitions whose type has subscriptions, in registration order. */
export function subscriptionDefinitions(): SourceDefinition[] {
  return sourceDefinitions().filter((definition) => definition.subscription && definition.storage);
}

/** How the UI names a type's subscriptions, e.g. the label of its subscription kind; the type's label without one. */
export function subscriptionKindLabel(type: string): string {
  const declaration = registeredDeclarations().get(type);
  return declaration?.kinds.find((kind) => kind.capability === 'subscription')?.label ?? declaration?.label ?? type;
}

/** The wire kind of a type's job with this role; null when the type has no job of that role. */
export function jobKind(type: string, role: JobRole): string | null {
  const name = registeredDeclarations().get(type)?.jobKindNames[role];
  return name ? `${type}.${name}` : null;
}

/**
 * Throws unless source types are registered and `plugins` are the registered server definitions'
 * types, in registration order: a process's jobs collect through its plugins while the Vault, the
 * subscriptions and the HTTP API read the registry, so the two name the same types. Null checks only
 * that types are registered, for a process that runs without plugins.
 */
export function checkRegisteredSources(plugins: readonly { id: string }[] | null): void {
  const registered = sourceDefinitions().map((definition) => definition.id);
  if (!plugins) return;
  const given = plugins.map((plugin) => plugin.id);
  if (registered.join('\n') !== given.join('\n')) {
    throw new Error(`The plugins (${given.join(', ') || 'none'}) are not the registered source types (${registered.join(', ')})`);
  }
}
