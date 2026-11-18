/**
 * The sources module as the server uses it: address recognition and the subscription catalog across
 * every source type. The product's source list takes each type's server entry from `server-entries.ts`
 * and its declaration from `declarations.ts`, which holds no Node code so the web page builds it too.
 */
export { SourceCatalog } from './source-catalog.js';
export { addressOwner, recognizeUrl, sourceTypeDeclarations, sourceTypeInfo, type SourceTypeDeclaration } from './source-types.js';
