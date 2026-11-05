import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../core/api-routes.js';
import { CollectorError } from '../../core/collector-error.js';
import type {
  NewVaultCheck,
  PackageDescription,
  VaultInspection,
  VaultSetupRequest,
  VaultSetupResult,
  VaultSetupStatus,
} from '../../core/vault-types.js';
import { serve } from '../api-route.js';

/** Vault location operations that stay available before a Vault is active. */
export interface VaultSetup {
  status(): VaultSetupStatus;
  inspect(path: string): Promise<VaultInspection>;
  /** Checks the new Vault folder `name` in `location` before it is created. */
  checkNew(location: unknown, name: unknown): Promise<NewVaultCheck>;
  /** Reads what an export file holds before a Vault is created from it. */
  describePackage(file: unknown): Promise<PackageDescription>;
  setup(request: VaultSetupRequest): Promise<VaultSetupResult>;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Reads the body of `POST /api/vault/setup`; see `VaultSetupRequest`. */
function setupRequest(body: Record<string, unknown>): VaultSetupRequest {
  const { action, location, name, path: vaultPath, packagePath } = body;
  if (action === 'open') {
    if (!text(vaultPath)) throw new CollectorError('invalid_request', '開啟知識庫時，請提供知識庫資料夾的完整路徑 path。');
    return { action, path: vaultPath };
  }
  if (action !== 'create' && action !== 'import') throw new CollectorError('invalid_request', 'action 必須是 create、open 或 import。');
  if (!text(location) || typeof name !== 'string') {
    throw new CollectorError('invalid_request', '建立知識庫時，請提供位置 location（完整路徑）與名稱 name。');
  }
  if (action === 'create') return { action, location, name };
  if (!text(packagePath)) throw new CollectorError('invalid_request', '從匯出檔建立知識庫時，請提供匯出檔的完整路徑 packagePath。');
  return { action, location, name, packagePath };
}

export function registerVaultSetupRoutes(app: FastifyInstance, vaultSetup: VaultSetup): void {
  serve(app, API_ROUTES.vaultSetup, async () => ({ vault: vaultSetup.status() }));
  serve(app, API_ROUTES.inspectVault, async (request: FastifyRequest<{ Body: { path?: unknown } }>) => {
    if (typeof request.body?.path !== 'string' || request.body.path.trim() === '') {
      throw new CollectorError('invalid_request', '請提供要檢查的目錄路徑。');
    }
    return { inspection: await vaultSetup.inspect(request.body.path) };
  });
  serve(app, API_ROUTES.checkNewVault, async (request: FastifyRequest<{ Body: { location?: unknown; name?: unknown } | undefined }>) => ({
    check: await vaultSetup.checkNew(request.body?.location, request.body?.name),
  }));
  serve(app, API_ROUTES.describePackage, async (request: FastifyRequest<{ Body: { path?: unknown } | undefined }>) => ({
    package: await vaultSetup.describePackage(request.body?.path),
  }));
  serve(app, API_ROUTES.setupVault, async (request: FastifyRequest<{ Body: Record<string, unknown> | undefined }>) => {
    return vaultSetup.setup(setupRequest(request.body ?? {}));
  });
}
