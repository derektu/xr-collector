import type { SourceDefinition, SourcePluginDeclaration } from './source-contract.js';
import type { SubscriptionExchange } from './subscription-exchange.js';
import type { JobRole } from './job-types.js';

/**
 * The declarations of a set of source types, in their order, as one value that cannot change. Who
 * assembles a process builds it once from the source list and hands it to what reads it; the web UI
 * reads it from React context (`src/web/source-declarations.tsx`), the server modules from the
 * `SourceRegistry` they are given. Core modules look types up here instead of
 * naming them, so a document, job or subscription of a type the value lacks is data the core keeps
 * but does not act on.
 */
export class SourceDeclarations {
  /** Every declaration, in order. */
  readonly list: readonly SourcePluginDeclaration[];
  private readonly byId: ReadonlyMap<string, SourcePluginDeclaration>;

  /** Throws for an empty list or a type ID listed twice: a process runs with at least one source type, each once. */
  constructor(list: readonly SourcePluginDeclaration[]) {
    if (list.length === 0) throw new Error('No source types are given');
    const byId = new Map<string, SourcePluginDeclaration>();
    for (const declaration of list) {
      if (byId.has(declaration.id)) throw new Error(`Source type ${declaration.id} is given twice`);
      byId.set(declaration.id, declaration);
    }
    this.list = Object.freeze([...list]);
    this.byId = byId;
    // A subclass adds its fields after this constructor returns and freezes itself.
    if (new.target === SourceDeclarations) Object.freeze(this);
  }

  get(type: string): SourcePluginDeclaration | undefined {
    return this.byId.get(type);
  }

  /** How the UI names a type's subscriptions, e.g. the label of its subscription kind; the type's label without one. */
  subscriptionKindLabel(type: string): string {
    const declaration = this.byId.get(type);
    return declaration?.kinds.find((kind) => kind.capability === 'subscription')?.label ?? declaration?.label ?? type;
  }

  /** The wire kind of a type's job with this role; null when the type has no job of that role. */
  jobKind(type: string, role: JobRole): string | null {
    const name = this.byId.get(type)?.jobKindNames[role];
    return name ? `${type}.${name}` : null;
  }
}

/** The Vault file of the automatic collection switch, relative to the Vault root, and how diagnostics name its content. */
export interface ScheduleFileInfo {
  file: string;
  description: string;
}

/**
 * The source types a server process runs with: their declarations, their server definitions, the
 * Vault file of the automatic collection switch that covers every type's subscriptions, and the
 * subscription files through which the Vault reads their subscriptions. The assembly builds it once
 * from the source plugins (`src/plugins/index.ts`) and hands it to the Vault, the subscriptions, the
 * jobs, search and the HTTP API; two registries in one process answer each from its own types.
 *
 * The module holds no Node-only code and no state of its own, so the web build shares it
 * (tests/tooling/web-bundle-node.test.ts, tests/tooling/source-registry-state.test.ts).
 */
export class SourceRegistry extends SourceDeclarations {
  /** Every server definition, in order. */
  readonly definitions: readonly SourceDefinition[];
  /** The definitions whose type has subscriptions, in order. */
  readonly subscriptionDefinitions: readonly SourceDefinition[];
  readonly schedule: Readonly<ScheduleFileInfo>;
  /** How opening, exporting and importing a Vault read the subscription and schedule files of these types. */
  readonly exchange: SubscriptionExchange;
  private readonly definitionById: ReadonlyMap<string, SourceDefinition>;

  /** `exchange` builds the subscription exchange of this registry once its definitions are in place. */
  constructor(
    definitions: readonly SourceDefinition[],
    schedule: ScheduleFileInfo,
    exchange: (registry: SourceRegistry) => SubscriptionExchange,
  ) {
    super(definitions);
    this.definitions = Object.freeze([...definitions]);
    this.subscriptionDefinitions = Object.freeze(this.definitions.filter((definition) => definition.subscription && definition.storage));
    this.schedule = Object.freeze({ ...schedule });
    this.definitionById = new Map(this.definitions.map((definition) => [definition.id, definition]));
    this.exchange = exchange(this);
    Object.freeze(this);
  }

  definition(type: string): SourceDefinition | undefined {
    return this.definitionById.get(type);
  }

  /** The server definition of a type the caller knows is in this registry. */
  require(type: string): SourceDefinition {
    const definition = this.definitionById.get(type);
    if (!definition) throw new Error(`Source type ${type} is not registered`);
    return definition;
  }

  /**
   * Throws unless `plugins` are this registry's types, in its order: a process's jobs collect through
   * its plugins while the Vault, the subscriptions and the HTTP API read the registry, so the two name
   * the same types.
   */
  checkPlugins(plugins: readonly { id: string }[]): void {
    const registered = this.definitions.map((definition) => definition.id);
    const given = plugins.map((plugin) => plugin.id);
    if (registered.join('\n') !== given.join('\n')) {
      throw new Error(`The plugins (${given.join(', ') || 'none'}) are not the registered source types (${registered.join(', ')})`);
    }
  }
}
