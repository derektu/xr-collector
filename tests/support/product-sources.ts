import type { SourceDefinition } from '../../src/core/source-contract.js';
import { SourceDeclarations, type SourceRegistry } from '../../src/core/source-registry.js';
import { SOURCE_DECLARATIONS } from '../../src/plugins/declarations.js';
import { SOURCE_DEFINITIONS, sourceRegistry } from '../../src/plugins/index.js';

/** The product's source types, as the web UI reads them. */
export const PRODUCT_DECLARATIONS = new SourceDeclarations(SOURCE_DECLARATIONS);

/** The product's source types, as the server modules and a runtime read them. */
export const PRODUCT_SOURCES = sourceRegistry();

/**
 * The product's source types with `extra` before RSS, the last product type: RSS owns every web
 * address, so a type that owns some of them comes before it.
 */
export function productSourcesWith(...extra: SourceDefinition[]): SourceRegistry {
  const product = [...SOURCE_DEFINITIONS];
  const last = product.pop()!;
  return sourceRegistry([...product, ...extra, last]);
}
