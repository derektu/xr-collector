import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import type { VaultWorkspace } from '../../vault/workspace.js';
import { serve } from '../api-route.js';

/** The active Vault's operations: its status, export, import, and creating or opening another Vault. */
export function registerVaultTransferRoutes(app: FastifyInstance, transfer: VaultWorkspace): void {
  serve(app, API_ROUTES.vaultStatus, async () => transfer.status());
  // Export and import name local files by absolute path. JSON requests need a CORS preflight,
  // which this server never grants, so only the app's own pages and authorized Agents can name files.
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
  serve(app, API_ROUTES.cancelVaultWait, async () => transfer.cancelWait());
  serve(app, API_ROUTES.openVault, async (request: FastifyRequest<{ Body: { path?: unknown } | undefined }>) => transfer.openOther(request.body?.path));
  serve(app, API_ROUTES.createVault, async (request: FastifyRequest<{ Body: { location?: unknown; name?: unknown } | undefined }>) => transfer.createNew(request.body?.location, request.body?.name));
}
