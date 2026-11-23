import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from '../../../shared/api/api-routes.js';
import { CollectorError } from '../../../shared/lib/collector-error.js';
import type { ActivityLogHealth } from '../../../shared/activity/activity-types.js';
import type { CollectorRuntimeStatus, NotificationAccess, NotificationState } from '../../../shared/api/device-types.js';
import { unavailableLoginStartup, type LoginStartupAccess } from '../../../shared/api/login-startup.js';
import type { SourceRegistry } from '../../../shared/sources/source-registry.js';
import type { BuildInfo, DeviceUpdateStatus, UpdateSelection } from '../../../shared/api/update-types.js';
import type { Pacing } from '../../../domain/pacing/index.js';
import type { UpdateAccess } from '../../../domain/updates/index.js';
import { serve } from '../api-route.js';
import type { NetworkGuard } from './network.js';

export interface DeviceRouteOptions {
  sources: SourceRegistry;
  buildInfo: BuildInfo;
  network: NetworkGuard;
  runtimeStatus?: () => CollectorRuntimeStatus;
  activityHealth?: () => ActivityLogHealth;
  notifications?: NotificationAccess;
  updates?: UpdateAccess;
  loginStartup?: LoginStartupAccess;
  pacing?: readonly Pacing[];
}

export function registerDeviceRoutes(app: FastifyInstance, options: DeviceRouteOptions): void {
  const { buildInfo, network } = options;
  let fallbackNotifications: NotificationState = { enabled: true, availability: 'unavailable', availabilityMessage: '系統通知僅能在桌面 App 使用。', active: [] };
  const notifications: NotificationAccess = options.notifications ?? {
    read: async () => fallbackNotifications,
    update: async (enabled) => (fallbackNotifications = { ...fallbackNotifications, enabled }),
  };

  serve(app, API_ROUTES.health, async () => {
    const runtime = options.runtimeStatus?.();
    return {
      status: runtime && runtime.state !== 'ready' ? 'unavailable' as const : 'ok' as const,
      ...(runtime ? { runtime } : {}),
      connectivity: network.status(),
      ...(options.activityHealth ? { activityLog: options.activityHealth() } : {}),
    };
  });

  const loginStartup = options.loginStartup ?? unavailableLoginStartup;
  serve(app, API_ROUTES.buildInfo, async () => ({ buildInfo }));
  serve(app, API_ROUTES.notifications, async () => ({ notifications: await notifications.read() }));
  serve(app, API_ROUTES.setNotifications, async (request: FastifyRequest<{ Body: { enabled?: unknown } }>) => {
    if (!request.body || typeof request.body.enabled !== 'boolean' || Object.keys(request.body).some((key) => key !== 'enabled')) {
      throw new CollectorError('invalid_request', '系統通知設定必須提供 enabled。');
    }
    return { notifications: await notifications.update(request.body.enabled) };
  });

  const unavailableUpdate = (): DeviceUpdateStatus => ({ phase: 'idle', currentVersion: buildInfo.version,
    target: buildInfo.target, installerAvailable: false, offer: null, ready: null, progress: null,
    lastAttempt: null, lastCheckAttemptAt: null, checkedAt: null, message: '此執行環境無法安裝更新。', errorCode: null });
  const updates: UpdateAccess = options.updates ?? {
    status: unavailableUpdate, check: async () => unavailableUpdate(), cancel: async () => unavailableUpdate(),
    download: async () => { throw new CollectorError('update_install_unavailable', '此執行環境無法安裝更新。'); },
    apply: async () => { throw new CollectorError('update_install_unavailable', '此執行環境無法安裝更新。'); },
  };
  serve(app, API_ROUTES.update, async () => ({ update: updates.status() }));
  serve(app, API_ROUTES.checkUpdate, async () => ({ update: await updates.check() }));
  serve(app, API_ROUTES.downloadUpdate, async (request: FastifyRequest<{ Body: unknown }>) => ({ update: await updates.download(updateSelection(request.body)) }));
  serve(app, API_ROUTES.applyUpdate, async (request: FastifyRequest<{ Body: unknown }>) => ({ update: await updates.apply(updateSelection(request.body)) }));
  serve(app, API_ROUTES.cancelUpdate, async () => ({ update: await updates.cancel() }));

  serve(app, API_ROUTES.loginStartup, async () => ({ loginStartup: await loginStartup.status() }));
  serve(app, API_ROUTES.setLoginStartup, async (request: FastifyRequest<{ Body: { enabled?: unknown } }>) => {
    const body = request.body ?? {};
    if (typeof body.enabled !== 'boolean' || Object.keys(body).some((field) => field !== 'enabled')) {
      throw new CollectorError('invalid_request', '請只提供 enabled，值必須是布林值。');
    }
    return { loginStartup: await loginStartup.update(body.enabled) };
  });

  serve(app, API_ROUTES.pacing, async () => ({
    groups: (options.pacing ?? []).map((gate) => ({ group: gate.group, label: pacingLabel(options.sources, gate.group), ...gate.status() })),
  }));
}

function updateSelection(body: unknown): UpdateSelection {
  if (!body || typeof body !== 'object') throw new CollectorError('invalid_request', '請提供更新版本與雜湊。');
  const value = body as Record<string, unknown>;
  if (typeof value.version !== 'string' || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.sha256) || Object.keys(value).some((key) => key !== 'version' && key !== 'sha256')) {
    throw new CollectorError('invalid_request', '請只提供有效的 version 與 sha256。');
  }
  return { version: value.version, sha256: value.sha256 };
}

function pacingLabel(sources: SourceRegistry, group: string): string {
  return sources.definitions.find((definition) => definition.pacing?.group === group)?.pacing?.label ?? group;
}
