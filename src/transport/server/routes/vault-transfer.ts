import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../../shared/api/api-routes.js';
import type { VaultOperations } from '../../../domain/vault/index.js';
import { serve } from '../api-route.js';

export function registerVaultTransferRoutes(app: FastifyInstance, transfer: VaultOperations): void {
  serve(app, API_ROUTES.vaultStatus, async () => transfer.status());
  // External: A browser sends a JSON request from another site only after a CORS preflight.
  // https://fetch.spec.whatwg.org/#cors-safelisted-request-header
  serve(app, API_ROUTES.exportSuggestion, async () => transfer.exportSuggestion());
  serve(app, API_ROUTES.exportVault, async (request: FastifyRequest<{ Body: { path?: unknown; overwrite?: unknown } | undefined }>) => {
    return transfer.exportTo(request.body?.path, request.body?.overwrite === true);
  });
  serve(app, API_ROUTES.previewImport, async (request: FastifyRequest<{ Body: { path?: unknown } | undefined }>) => transfer.previewImport(request.body?.path));
  serve(app, API_ROUTES.applyImport, async (request: FastifyRequest<{ Body: { id?: unknown; mode?: unknown } | undefined }>) => {
    return transfer.applyImport(String(request.body?.id ?? ''), request.body?.mode);
  });
  serve(app, API_ROUTES.cancelImport, async (request: FastifyRequest<{ Body: { id?: unknown } | undefined }>) => {
    transfer.cancelImport(String(request.body?.id ?? ''));
    return { cancelled: true as const };
  });
  serve(app, API_ROUTES.openVault, async (request: FastifyRequest<{ Body: { path?: unknown } | undefined }>) => transfer.openOther(request.body?.path));
  serve(app, API_ROUTES.createVault, async (request: FastifyRequest<{ Body: { location?: unknown; name?: unknown } | undefined }>) => transfer.createNew(request.body?.location, request.body?.name));
}
