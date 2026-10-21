import type { SourceDefinition, SourcePluginDeclaration } from '../plugins/types.js';
import type { JobRole } from './types.js';

/**
 * The source types this process knows, in registration order. The composition roots register the
 * assembled plugins before anything reads a Vault (`src/plugins/index.ts`); the web UI registers the
 * declarations it imports (`src/web/plugins.tsx`). Core modules look types up here instead of naming
 * them, so a document, job or subscription of an unregistered type is data the core keeps but does
 * not act on.
 *
 * The module holds no Node-only code, so the web build shares it.
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

/** Every registered declaration, in registration order. */
export function sourceDeclarations(): SourcePluginDeclaration[] {
  return [...declarations.values()];
}

export function sourceDeclaration(type: string): SourcePluginDeclaration | undefined {
  return declarations.get(type);
}

/** Every registered server definition, in registration order. */
export function sourceDefinitions(): SourceDefinition[] {
  return [...definitions.values()];
}

export function sourceDefinition(type: string): SourceDefinition | undefined {
  return definitions.get(type);
}

/** The server definition of a type the caller knows is registered. */
export function requireDefinition(type: string): SourceDefinition {
  const definition = definitions.get(type);
  if (!definition) throw new Error(`Source type ${type} is not registered`);
  return definition;
}

/** Registered definitions whose type has subscriptions, in registration order. */
export function subscriptionDefinitions(): SourceDefinition[] {
  return sourceDefinitions().filter((definition) => definition.subscription && definition.storage);
}

/** How the UI names a type's subscriptions, e.g. the label of its subscription kind; the type's label without one. */
export function subscriptionKindLabel(type: string): string {
  const declaration = declarations.get(type);
  return declaration?.kinds.find((kind) => kind.capability === 'subscription')?.label ?? declaration?.label ?? type;
}

/** The wire kind of a type's job with this role; null when the type has no job of that role. */
export function jobKind(type: string, role: JobRole): string | null {
  const name = declarations.get(type)?.jobKindNames[role];
  return name ? `${type}.${name}` : null;
}

/** The source type and role of a job kind; null for a kind of an unregistered type or an unknown name. */
export function jobRole(kind: string): { type: string; role: JobRole } | null {
  const separator = kind.indexOf('.');
  if (separator < 0) return null;
  const type = kind.slice(0, separator);
  const name = kind.slice(separator + 1);
  const names = declarations.get(type)?.jobKindNames;
  if (!names) return null;
  const role = (['item', 'check', 'add'] as const).find((candidate) => names[candidate] === name);
  return role ? { type, role } : null;
}
