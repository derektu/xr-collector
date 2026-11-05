import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import { CollectorError } from '../../core/collector-error.js';
import type { Collector } from '../../core/collector.js';
import { trimSearchQueryWhitespace } from '../../core/search-query.js';
import type { SearchStatusReport, TranscriptSearch } from '../../core/search-types.js';
import type { SourceRegistry } from '../../core/source-registry.js';
import type { SubscriptionRecord } from '../../core/subscription-types.js';
import { serve } from '../api-route.js';
import { documentFilter, isCalendarDate, pagination, singleValues } from './query-params.js';
import type { SubscriptionCollection } from './subscriptions.js';

export interface DocumentRouteOptions {
  sources: SourceRegistry;
  collector?: Collector;
  search?: TranscriptSearch;
  /** The subscriptions of each source type with subscriptions, which name the sources of documents. */
  subscriptions: readonly SubscriptionCollection[];
}

/** The documents of the active Vault: listing, their sources, search and the index, reading and deleting. */
export function registerDocumentRoutes(app: FastifyInstance, options: DocumentRouteOptions): void {
  const { sources, subscriptions } = options;
  serve(app, API_ROUTES.documents, async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>) => {
    const query = singleValues(request.query);
    return options.collector!.listDocuments(documentFilter(sources, query), pagination(query));
  });

  serve(app, API_ROUTES.documentSources, async () => {
    const byType: Record<string, { subscriptions: SubscriptionRecord[]; removals: Array<{ id: string; title: string }> }> = {};
    for (const collection of subscriptions) {
      byType[collection.type] = { subscriptions: await collection.list(), removals: await collection.listRemovals?.() ?? [] };
    }
    return { sources: await options.collector!.sources(byType) };
  });

  serve(app, API_ROUTES.search, async (request: FastifyRequest<{ Querystring: Record<string, unknown> }>) => {
    if (!options.search) {
      throw new CollectorError('search_unavailable', '搜尋服務尚未啟用。');
    }
    const parameters = singleValues(request.query);
    const query = typeof parameters.q === 'string' ? trimSearchQueryWhitespace(parameters.q) : '';
    const { publishedFrom, publishedTo } = parameters;
    if (query.length > 500) {
      throw new CollectorError('invalid_request', '搜尋條件過長。');
    }
    if (
      (publishedFrom && !isCalendarDate(publishedFrom))
      || (publishedTo && !isCalendarDate(publishedTo))
      || (publishedFrom && publishedTo && publishedFrom > publishedTo)
    ) {
      throw new CollectorError('invalid_request', '發布日期篩選無效。');
    }
    const page = pagination(parameters);
    if (page.offset % page.limit !== 0) {
      throw new CollectorError('invalid_request', '搜尋的 offset 必須是 limit 的整數倍。');
    }
    return options.search.search({
      query,
      ...documentFilter(sources, parameters),
      ...(publishedFrom ? { publishedFrom } : {}),
      ...(publishedTo ? { publishedTo } : {}),
      ...page,
    });
  });

  const searchStatus = async (): Promise<SearchStatusReport> => ({
    ...(options.search?.status() ?? {
      state: 'error',
      indexedDocuments: 0,
      lastRebuiltAt: null,
      message: '搜尋服務尚未啟用。',
    }),
    vaultDocuments: (await options.collector?.list())?.length ?? 0,
  });

  serve(app, API_ROUTES.searchStatus, async () => ({ status: await searchStatus() }));

  serve(app, API_ROUTES.rebuildSearch, async () => {
    if (!options.search) {
      throw new CollectorError('search_unavailable', '搜尋服務尚未啟用。');
    }
    await options.search.rebuild();
    return { status: await searchStatus() };
  });

  serve(app, API_ROUTES.document, async (request: FastifyRequest<{ Params: { id: string } }>) => ({
    document: await options.collector!.read(request.params.id),
  }));

  serve(app, API_ROUTES.deleteDocument, async (request: FastifyRequest<{ Params: { id: string } }>) =>
    options.collector!.delete(request.params.id));
}
