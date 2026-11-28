import type { SourceDefinition, SourcePluginDeclaration } from './source-contract.js';
import type { SubscriptionExchange } from '../subscriptions/subscription-exchange.js';
import type { JobRole } from '../jobs/job-types.js';
import type { SubscriptionSettings } from '../subscriptions/subscription-types.js';
import { withCommonSettings } from './collection-settings.js';

/**
 * The source types as the core uses them: each subscribing type's settings carry the settings every
 * type has (`documentStatus`) besides the ones its plugin declares.
 */
export class SourceDeclarations {
  readonly list: readonly SourcePluginDeclaration<SubscriptionSettings>[];
  private readonly byId: ReadonlyMap<string, SourcePluginDeclaration<SubscriptionSettings>>;

  constructor(declared: readonly SourcePluginDeclaration[]) {
    if (declared.length === 0) throw new Error('No source types are given');
    const list = declared.map(withCommonSettings);
    const byId = new Map<string, SourcePluginDeclaration<SubscriptionSettings>>();
    for (const declaration of list) {
      if (byId.has(declaration.id)) throw new Error(`Source type ${declaration.id} is given twice`);
      byId.set(declaration.id, declaration);
    }
    this.list = Object.freeze([...list]);
    this.byId = byId;
    if (new.target === SourceDeclarations) Object.freeze(this);
  }

  get(type: string): SourcePluginDeclaration<SubscriptionSettings> | undefined {
    return this.byId.get(type);
  }

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

/** `file` is relative to the Vault root; `description` names its content in diagnostics. */
export interface ScheduleFileInfo {
  file: string;
  description: string;
}

export class SourceRegistry extends SourceDeclarations {
  readonly definitions: readonly SourceDefinition<SubscriptionSettings>[];
  readonly subscriptionDefinitions: readonly SourceDefinition<SubscriptionSettings>[];
  readonly schedule: Readonly<ScheduleFileInfo>;
  readonly exchange: SubscriptionExchange;
  private readonly definitionById: ReadonlyMap<string, SourceDefinition<SubscriptionSettings>>;

  constructor(
    declared: readonly SourceDefinition[],
    schedule: ScheduleFileInfo,
    exchange: (registry: SourceRegistry) => SubscriptionExchange,
  ) {
    super(declared);
    this.definitions = Object.freeze(declared.map(withCommonSettings));
    this.subscriptionDefinitions = Object.freeze(this.definitions.filter((definition) => definition.subscription && definition.storage));
    this.schedule = Object.freeze({ ...schedule });
    this.definitionById = new Map(this.definitions.map((definition) => [definition.id, definition]));
    this.exchange = exchange(this);
    Object.freeze(this);
  }

  definition(type: string): SourceDefinition<SubscriptionSettings> | undefined {
    return this.definitionById.get(type);
  }

  require(type: string): SourceDefinition<SubscriptionSettings> {
    const definition = this.definitionById.get(type);
    if (!definition) throw new Error(`Source type ${type} is not registered`);
    return definition;
  }

  checkPlugins(plugins: readonly { id: string }[]): void {
    const registered = this.definitions.map((definition) => definition.id);
    const given = plugins.map((plugin) => plugin.id);
    if (registered.join('\n') !== given.join('\n')) {
      throw new Error(`The plugins (${given.join(', ') || 'none'}) are not the registered source types (${registered.join(', ')})`);
    }
  }
}
